/**
 * Minimal TypeSafe System One client.
 *
 * No SDK dependency: the surface is one endpoint, so a vendored client would be more code to
 * audit than the request itself.
 *
 * WIRE SHAPE. The request and response schemas below are TypeSafe's documented System One shape:
 * a `questions` map keyed by question id, each entry carrying its own `type` and `instructions`,
 * answered by an `answers` map keyed by the same ids. This repository has never exercised the live
 * API, so the shape's authority is the vendor's published HTTP reference and the dual-control
 * review of #1623 that read it — not a recorded capture. The fixture under
 * `src/__tests__/fixtures/jev-judge/` is synthesised from that documented shape and is therefore
 * evidence that the parser and the documentation agree, never evidence that the parser and the
 * live API agree. The first live call is what settles the second question, and it is the
 * operator's.
 *
 * The parse is strict on the fields the experiment reads and forgiving of fields it does not:
 * an unknown TOP-LEVEL key is recorded in the call log and the call proceeds, because aborting a
 * measurement on a newly added request id would be a harness defect wearing a safety costume. A
 * wrong shape in a field that IS read — a missing `noul`, an answer whose `type` disagrees with
 * its question, a `choice` outside the offered criteria, or `probabilities` that omit the chosen
 * label — raises `jev_response_shape_unrecognised` with the raw text preserved in the call log,
 * rather than defaulting a probability.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { z } from 'zod';

import {
  JEV_DEFAULT_BASE_URL,
  JEV_MODEL_ID,
  JEV_SYSTEM_ONE_PATH,
  type JevChoiceLabel,
} from './constants.js';

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export interface JevNoulQuestion {
  type: 'noul';
  instructions: string;
}

export interface JevChoiceQuestion {
  type: 'choice';
  instructions: string;
  /** Label to the criterion that label means. The answer's `choice` must be one of these keys. */
  criteria: Record<string, string>;
}

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion;

export interface JevRequest {
  state: string;
  questions: Record<string, JevQuestion>;
}

/** The serialised request body, exactly as it goes on the wire. Exported so a test can pin it. */
export interface JevRequestBody {
  state: string;
  model: string;
  questions: Record<string, JevQuestion>;
}

/**
 * Key order here is the body's key order, because `JSON.stringify` preserves insertion order and
 * the golden-request test compares bytes. Changing the order changes the fixture, deliberately.
 */
export function buildJevRequestBody(request: JevRequest): JevRequestBody {
  return { state: request.state, model: JEV_MODEL_ID, questions: request.questions };
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/** A Noul answer carries a probability and NO confidence. Requiring one would reject every real
 *  response. */
const noulAnswerSchema = z
  .object({
    type: z.literal('noul'),
    noul: z.number().min(0).max(1),
  })
  .passthrough();

const choiceAnswerSchema = z
  .object({
    type: z.literal('choice'),
    choice: z.string().min(1),
    probabilities: z.record(z.number().min(0).max(1)),
    confidence: z.number().min(0).max(1),
  })
  .passthrough();

export const jevAnswerSchema = z.discriminatedUnion('type', [noulAnswerSchema, choiceAnswerSchema]);
export type JevAnswer = z.infer<typeof jevAnswerSchema>;

export const jevResponseSchema = z
  .object({
    model: z.string().min(1),
    answers: z.record(jevAnswerSchema),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type JevResponse = z.infer<typeof jevResponseSchema>;

/** The keys the parse reads. Anything else at the top level is logged, not fatal. */
export const JEV_KNOWN_TOP_LEVEL_KEYS = ['model', 'answers', 'usage'] as const;

export function unknownTopLevelKeys(parsed: unknown): string[] {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const known = new Set<string>(JEV_KNOWN_TOP_LEVEL_KEYS);
  return Object.keys(parsed as Record<string, unknown>).filter((key) => !known.has(key));
}

/**
 * Cross-checks the answers against the questions that were actually asked.
 *
 * The schema alone cannot do this: `{ type: "choice", ... }` is a perfectly well-formed answer,
 * and is still wrong when the question asked for a Noul. An answer that is absent, mistyped, or
 * names a label outside the criteria offered is a shape error, because every one of them would
 * otherwise reach the metrics as a silently substituted value.
 *
 * Answers to questions that were not asked are logged by the caller and ignored rather than
 * raised: they cost nothing and are not read.
 */
export function assertAnswersMatchQuestions(request: JevRequest, response: JevResponse): void {
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = response.answers[id];
    if (!answer) {
      throw new Error(`jev_response_shape_unrecognised:answers.${id}`);
    }
    if (answer.type !== question.type) {
      throw new Error(`jev_response_shape_unrecognised:answers.${id}.type`);
    }
    if (answer.type === 'choice' && question.type === 'choice') {
      if (!Object.hasOwn(question.criteria, answer.choice)) {
        throw new Error(`jev_response_shape_unrecognised:answers.${id}.choice`);
      }
      if (!Object.hasOwn(answer.probabilities, answer.choice)) {
        throw new Error(`jev_response_shape_unrecognised:answers.${id}.probabilities`);
      }
    }
  }
}

export function unansweredQuestionIds(request: JevRequest, response: JevResponse): string[] {
  return Object.keys(response.answers).filter((id) => !Object.hasOwn(request.questions, id));
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface JevCallResult {
  response: JevResponse;
  attempts: number;
  inputTokens: number | null;
}

export interface JevClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Append-only JSONL of every request and every response, including retried attempts. */
  logPath: string;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  maxAttempts?: number;
  now?: () => Date;
}

/**
 * `529` is TypeSafe's documented Overloaded status and is transient, so it retries.
 *
 * `422` is deliberately absent and must stay absent: it is the status the API returns for a
 * request body it does not accept, which is exactly the failure this experiment must surface
 * rather than paper over. Retrying it would turn one loud shape error into five quiet ones.
 */
export const JEV_RETRYABLE_STATUS: ReadonlySet<number> = new Set([
  408, 409, 425, 429, 500, 502, 503, 504, 529,
]);

/** The status whose body is always logged as a shape error, and never retried. */
export const JEV_SHAPE_ERROR_STATUS = 422;

/**
 * `retry-after` is either delta-seconds or an HTTP-date. Both are honoured; an unparseable value
 * falls back to the attempt's linear backoff rather than retrying immediately.
 */
export function retryAfterMilliseconds(
  header: string | null,
  now: Date,
  fallbackMilliseconds: number,
): number {
  if (!header) return fallbackMilliseconds;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - now.getTime());
  return fallbackMilliseconds;
}

export class JevClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly logPath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly now: () => Date;

  constructor(options: JevClientOptions) {
    if (!options.apiKey) throw new Error('not_run: missing_api_key');
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? JEV_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.logPath = options.logPath;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxAttempts = options.maxAttempts ?? 5;
    this.now = options.now ?? (() => new Date());
    mkdirSync(dirname(this.logPath), { recursive: true });
  }

  /** Never logs the key: the log carries the request body and the response, nothing else. */
  private log(entry: Record<string, unknown>): void {
    appendFileSync(this.logPath, `${JSON.stringify({ at: this.now().toISOString(), ...entry })}\n`);
  }

  async call(callId: string, request: JevRequest): Promise<JevCallResult> {
    const body = buildJevRequestBody(request);
    let lastStatus: number | null = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      this.log({ callId, attempt, direction: 'request', body });
      const response = await this.fetchImpl(`${this.baseUrl}${JEV_SYSTEM_ONE_PATH}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      lastStatus = response.status;
      this.log({ callId, attempt, direction: 'response', status: response.status, body: text });

      if (!response.ok) {
        if (response.status === JEV_SHAPE_ERROR_STATUS) {
          // Named separately from the generic response line so the run's own log says "the API
          // rejected our body", which is the one diagnosis a reader needs and the one a bare
          // status code buries.
          this.log({ callId, attempt, direction: 'request_rejected', status: 422, body: text });
        }
        if (!JEV_RETRYABLE_STATUS.has(response.status) || attempt === this.maxAttempts) {
          throw new Error(`jev_http_error:${response.status}`);
        }
        await this.sleep(
          retryAfterMilliseconds(response.headers.get('retry-after'), this.now(), attempt * 1000),
        );
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error('jev_response_shape_unrecognised:not_json');
      }

      const unknownKeys = unknownTopLevelKeys(parsed);
      if (unknownKeys.length > 0) {
        this.log({ callId, attempt, direction: 'response_unknown_top_level_keys', unknownKeys });
      }

      const result = jevResponseSchema.safeParse(parsed);
      if (!result.success) {
        throw new Error(
          `jev_response_shape_unrecognised:${result.error.issues[0]?.path.join('.')}`,
        );
      }
      assertAnswersMatchQuestions(request, result.data);
      const unanswered = unansweredQuestionIds(request, result.data);
      if (unanswered.length > 0) {
        this.log({ callId, attempt, direction: 'response_unrequested_answers', ids: unanswered });
      }

      return {
        response: result.data,
        attempts: attempt,
        inputTokens: result.data.usage?.input_tokens ?? null,
      };
    }

    throw new Error(`jev_http_error:${lastStatus ?? 'unknown'}`);
  }
}

// ---------------------------------------------------------------------------
// Answer readers
// ---------------------------------------------------------------------------

export function noulProbability(response: JevResponse, id: string): number {
  const answer = response.answers[id];
  if (!answer) throw new Error(`jev_missing_noul_answer:${id}`);
  if (answer.type !== 'noul') throw new Error(`jev_response_shape_unrecognised:answers.${id}.type`);
  return answer.noul;
}

export function choiceLabel(
  response: JevResponse,
  id: string,
  allowed: readonly JevChoiceLabel[],
): JevChoiceLabel {
  const answer = response.answers[id];
  if (!answer) throw new Error(`jev_missing_choice_answer:${id}`);
  if (answer.type !== 'choice') {
    throw new Error(`jev_response_shape_unrecognised:answers.${id}.type`);
  }
  if (!allowed.includes(answer.choice as JevChoiceLabel)) {
    throw new Error(`jev_choice_label_out_of_set:${answer.choice}`);
  }
  return answer.choice as JevChoiceLabel;
}
