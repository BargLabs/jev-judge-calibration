/**
 * Builds the Jev judge corpus: selection, construction, persuasive rewrite, manifest.
 *
 * This is the tool operator step 3 executes. It exists because "the corpus is the operator's to
 * build" was the wrong reading of the constraint that the AGENT makes no live call: that
 * constraint bounds who presses the key, not whether the key has anything to press. A protocol
 * whose corpus step has no implementation is not a protocol.
 *
 * Every outward call goes through an injected seam — `GitHubReader` for GitHub, `JevRewriter` for
 * Anthropic — so the whole builder is exercised offline against fakes. `GhGitHubReader` shells out
 * to the operator's already-authenticated `gh`; no token is read, held, or written by this module.
 *
 * FRAME EXCLUSION. The operator's exclusion list is closed-class. It is read from the environment,
 * its absence refuses the build outright, and only its COUNT is ever published. The builder does
 * not merely decline to print its entries: it re-reads its own output bytes and refuses if any
 * entry appears in them, naming the file but never the entry, because an error message that named
 * the leaked value would itself be the leak.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

import { z } from 'zod';

import {
  JEV_ERRATA_2_2026_09_20_PATH,
  JEV_ERRATA_3_2026_09_20_PATH,
  JEV_ERRATA_2026_09_20_PATH,
  JEV_GH_BACKOFF_BASE_MS,
  JEV_GH_BACKOFF_CAP_MS,
  JEV_GH_MAX_ATTEMPTS,
  JEV_PROTOCOL_VERSION,
  JEV_REWRITE_API_KEY_ENV,
  JEV_REWRITE_MAX_ATTEMPTS,
  JEV_REWRITE_MAX_TOKENS,
  JEV_REWRITE_MODEL_ID,
  JEV_SELECTION_QUERY,
  JEV_SELECTION_SEED,
  type JevVariant,
  resolveGhMinIntervalMs,
  resolveGhSearchMinIntervalMs,
} from './constants.js';
import {
  type BuildManifestOptions,
  type CaseCounts,
  JEV_REWRITE_PROMPT_DIGEST,
  type JevCase,
  type JevCorpus,
  type JevCorpusManifest,
  type JevEvidence,
  acceptRewrite,
  buildManifest,
  buildRewritePrompt,
  canonicalJson,
  caseCountsFromCases,
  constructPlainCases,
  containsFrameExclusion,
  corpusFilePaths,
  jevCorpusSchema,
  persuasiveCase,
  realizedCaseCounts,
} from './corpus.js';
import { assertErratumFrozen } from './runner.js';
import {
  type CandidateRead,
  type GitHubReader,
  type PoolEntry,
  type SearchPullRequestsQuery,
  readFrameExclusions,
  selectBaseCases,
} from './selection.js';

// ---------------------------------------------------------------------------
// GitHub, over the operator's own `gh`
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

export type GhRunner = (args: readonly string[]) => Promise<string>;

/**
 * Inherits the ambient environment so `gh` resolves the operator's existing login exactly as it
 * does on their shell. This module never reads, sets, or forwards a token of its own: there is no
 * `GITHUB_TOKEN` access anywhere in it, and the credential never enters this process's data flow.
 */
export const defaultGhRunner: GhRunner = async (args) => {
  const { stdout } = await execFileAsync('gh', [...args], { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
};

const searchResponseSchema = z.object({
  items: z.array(z.object({ number: z.number().int().positive(), repository_url: z.string() })),
});

const pullRequestSchema = z.object({
  state: z.string(),
  merged: z.boolean().optional(),
  merged_at: z.string().nullable().optional(),
  created_at: z.string(),
  body: z.string().nullable(),
  head: z.object({ sha: z.string() }),
  base: z.object({ ref: z.string() }),
});

const repositorySchema = z.object({ archived: z.boolean().optional() });

const commitsSchema = z.array(
  z.object({ sha: z.string(), commit: z.object({ message: z.string() }) }),
);

const filesSchema = z.array(
  z.object({
    filename: z.string(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  }),
);

const checkRunsSchema = z.object({
  total_count: z.number().int().nonnegative(),
  check_runs: z.array(z.object({ conclusion: z.string().nullable() })),
});

function repositoryFromUrl(url: string): string {
  return url.replace(/^.*\/repos\//, '');
}

function summariseCheckRuns(runs: { conclusion: string | null }[]): JevEvidence['checkRuns'] {
  const summary = {
    total: runs.length,
    success: 0,
    failure: 0,
    neutral: 0,
    skipped: 0,
    cancelled: 0,
    timedOut: 0,
  };
  for (const run of runs) {
    if (run.conclusion === 'success') summary.success += 1;
    else if (run.conclusion === 'failure' || run.conclusion === 'action_required')
      summary.failure += 1;
    else if (run.conclusion === 'neutral') summary.neutral += 1;
    else if (run.conclusion === 'skipped') summary.skipped += 1;
    else if (run.conclusion === 'cancelled') summary.cancelled += 1;
    else if (run.conclusion === 'timed_out') summary.timedOut += 1;
  }
  return summary;
}

export interface GhIncludeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Parses `gh api ... -i` output: an HTTP status line, header lines, a blank line, then the body.
 * A rate-limited request goes through this same parser on the error path: `execFile`'s promisified
 * rejection carries the `stdout` the process wrote before it decided to exit non-zero, and that is
 * exactly where the `retry-after` and `x-ratelimit-reset` headers live.
 */
export function parseGhIncludeOutput(raw: string): GhIncludeResponse {
  const crlfAt = raw.indexOf('\r\n\r\n');
  const lfAt = raw.indexOf('\n\n');
  const useCrlf = crlfAt !== -1 && (lfAt === -1 || crlfAt <= lfAt);
  const separatorIndex = useCrlf ? crlfAt : lfAt;
  if (separatorIndex === -1) throw new Error('gh_include_output_unparseable');
  const separator = useCrlf ? '\r\n' : '\n';

  const headerLines = raw.slice(0, separatorIndex).split(separator);
  const body = raw.slice(separatorIndex + separator.length * 2);
  const statusMatch = /^HTTP\/[\d.]+\s+(\d{3})/.exec(headerLines[0] ?? '');
  if (!statusMatch) throw new Error('gh_include_output_unparseable');

  const headers: Record<string, string> = {};
  for (const line of headerLines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status: Number(statusMatch[1]), headers, body };
}

interface RateLimitedResponse extends GhIncludeResponse {
  reason: 'secondary_rate_limit' | 'primary_rate_limit';
}

const RATE_LIMIT_PHRASE = /secondary rate limit|rate limit exceeded|api rate limit/i;

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * `null` when the error is not a rate limit at all — a 404, a permission error, a network
 * failure — so the caller rethrows it unchanged rather than spending the retry budget on it.
 * A 403 only counts when its text names a rate limit: the same status covers "you may not read
 * this repository", which retrying can never fix.
 *
 * `gh`'s own rate-limit message goes to STDERR, not stdout: the first live run's `error.stdout`
 * was empty and this function returned `null` on exactly the failure it exists to catch, so the
 * backoff never engaged and the run died with a plain exit 1. Every channel `execFile`'s
 * promisified rejection can carry — `stdout` (present only when `-i` returned a parseable
 * response before the process exited non-zero), `stderr`, and the error's own `message` — is
 * inspected in that order.
 */
function classifyRateLimit(error: unknown): RateLimitedResponse | null {
  const err = error as { stdout?: unknown; stderr?: unknown; message?: unknown } | null | undefined;
  const stdout = textOf(err?.stdout);
  const stderr = textOf(err?.stderr);
  const message = textOf(err?.message);

  let parsed: GhIncludeResponse | null = null;
  if (stdout.length > 0) {
    try {
      parsed = parseGhIncludeOutput(stdout);
    } catch {
      parsed = null;
    }
  }

  if (parsed !== null && parsed.status === 429) {
    return { ...parsed, reason: 'primary_rate_limit' };
  }
  if (parsed !== null && parsed.status === 403 && RATE_LIMIT_PHRASE.test(parsed.body)) {
    return { ...parsed, reason: 'secondary_rate_limit' };
  }

  // No structured `-i` response to read headers from (or its status/body did not name a rate
  // limit): fall back to a plain phrase match across every channel. No `retry-after` or
  // `x-ratelimit-reset` header is available here, so the wait falls back to exponential backoff.
  for (const text of [stdout, stderr, message]) {
    if (!RATE_LIMIT_PHRASE.test(text)) continue;
    const status = /\b429\b/.test(text) ? 429 : 403;
    return {
      status,
      headers: {},
      body: text,
      reason: status === 429 ? 'primary_rate_limit' : 'secondary_rate_limit',
    };
  }

  return null;
}

/** `retry-after` first, then `x-ratelimit-reset`, then exponential from 30s capped at 15 minutes. */
function computeBackoffWaitMs(
  response: RateLimitedResponse,
  attempt: number,
  now: () => number,
): { waitMs: number; reason: string } {
  const retryAfter = response.headers['retry-after'];
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return { waitMs: seconds * 1000, reason: `retry-after=${seconds}s` };
    }
  }
  const reset = response.headers['x-ratelimit-reset'];
  if (reset !== undefined) {
    const resetMs = Number(reset) * 1000;
    if (Number.isFinite(resetMs)) {
      return { waitMs: Math.max(0, resetMs - now()), reason: `x-ratelimit-reset=${reset}` };
    }
  }
  const waitMs = Math.min(JEV_GH_BACKOFF_BASE_MS * 2 ** (attempt - 1), JEV_GH_BACKOFF_CAP_MS);
  return { waitMs, reason: `exponential_backoff_attempt_${attempt}` };
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export interface GhGitHubReaderOptions {
  minIntervalMs?: number;
  /** Pacing floor for `search/issues` calls specifically; see `JEV_GH_SEARCH_MIN_INTERVAL_MS`. */
  searchMinIntervalMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onWait?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
}

type GhRequestLane = 'rest' | 'search';

export class GhGitHubReader implements GitHubReader {
  private readonly run: GhRunner;
  private readonly minIntervalMs: number;
  private readonly searchMinIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly onWait: (message: string) => void;
  private lastRequestAt: number | null = null;
  private lastSearchRequestAt: number | null = null;

  constructor(run: GhRunner = defaultGhRunner, options: GhGitHubReaderOptions = {}) {
    this.run = run;
    this.minIntervalMs = options.minIntervalMs ?? resolveGhMinIntervalMs(options.env);
    this.searchMinIntervalMs =
      options.searchMinIntervalMs ?? resolveGhSearchMinIntervalMs(options.env);
    this.maxAttempts = options.maxAttempts ?? JEV_GH_MAX_ATTEMPTS;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.onWait = options.onWait ?? ((message) => process.stderr.write(`${message}\n`));
  }

  /**
   * Blocks until at least the lane's own minimum interval has passed since that lane's previous
   * request started. `search/issues` carries a separate, tighter secondary limit than the rest of
   * the REST surface, so it paces against its own clock rather than the general one.
   */
  private async pace(lane: GhRequestLane): Promise<void> {
    const lastRequestAt = lane === 'search' ? this.lastSearchRequestAt : this.lastRequestAt;
    const minIntervalMs = lane === 'search' ? this.searchMinIntervalMs : this.minIntervalMs;
    if (lastRequestAt !== null) {
      const remaining = minIntervalMs - (this.now() - lastRequestAt);
      if (remaining > 0) await this.sleep(remaining);
    }
    if (lane === 'search') this.lastSearchRequestAt = this.now();
    else this.lastRequestAt = this.now();
  }

  /**
   * Every outward request funnels through here: paced against the previous one on its own lane,
   * and retried with backoff on a rate limit. `-i` is appended so a rate-limited response's
   * headers are available to parse regardless of which call site is asking.
   */
  private async call(args: readonly string[], lane: GhRequestLane = 'rest'): Promise<string> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      await this.pace(lane);
      try {
        const raw = await this.run([...args, '-i']);
        return parseGhIncludeOutput(raw).body;
      } catch (error) {
        const limited = classifyRateLimit(error);
        if (limited === null) throw error;
        if (attempt === this.maxAttempts) {
          throw new Error('not_run: github_rate_limited_after_retries');
        }
        const { waitMs, reason } = computeBackoffWaitMs(limited, attempt, this.now);
        this.onWait(
          `github ${limited.reason} (${reason}); waiting ${waitMs}ms before attempt ` +
            `${attempt + 1}/${this.maxAttempts}`,
        );
        await this.sleep(waitMs);
      }
    }
    throw new Error('not_run: github_rate_limited_after_retries');
  }

  private async json(path: string): Promise<unknown> {
    return JSON.parse(await this.call(['api', '-H', 'Accept: application/vnd.github+json', path]));
  }

  /**
   * Walks pages `startPage..maxPages`, freezing each one to the caller via `onPage` as soon as it
   * succeeds, and stops early on a short page. If a page's own request exhausts the retry budget,
   * this rejects without calling `onPage` for it — the caller's already-frozen earlier pages
   * stand, since freezing happened synchronously before this loop moved on.
   */
  async searchPullRequests(query: SearchPullRequestsQuery): Promise<void> {
    for (let page = query.startPage; page <= query.maxPages; page += 1) {
      const raw = await this.call(
        [
          'api',
          '-X',
          'GET',
          'search/issues',
          '-f',
          `q=${query.q}`,
          '-f',
          `sort=${query.sort}`,
          '-f',
          `order=${query.order}`,
          '-F',
          `per_page=${query.perPage}`,
          '-F',
          `page=${page}`,
        ],
        'search',
      );
      const parsed = searchResponseSchema.parse(JSON.parse(raw));
      const entries = parsed.items.map((item) => ({
        repository: repositoryFromUrl(item.repository_url),
        number: item.number,
      }));
      // A short page is the last page. Breaking on it rather than always walking `maxPages` keeps
      // the pool identical while spending fewer requests.
      const isShortPage = parsed.items.length < query.perPage;
      await query.onPage(page, entries, isShortPage);
      if (isShortPage) break;
    }
  }

  /**
   * `null` means unreadable — private, deleted, or a 404 — which selection counts separately from
   * "not merged". A candidate that IS readable but not merged is returned with its real state so
   * selection attributes it to `not_merged` rather than to unreadability.
   */
  async readCandidate(entry: PoolEntry): Promise<CandidateRead | null> {
    const [owner, repo] = entry.repository.split('/');
    if (!owner || !repo) return null;
    const base = `repos/${owner}/${repo}`;

    try {
      const repository = repositorySchema.parse(await this.json(base));
      const pull = pullRequestSchema.parse(await this.json(`${base}/pulls/${entry.number}`));
      const commits = commitsSchema.parse(
        await this.json(`${base}/pulls/${entry.number}/commits?per_page=100`),
      );
      const files = filesSchema.parse(
        await this.json(`${base}/pulls/${entry.number}/files?per_page=100`),
      );
      const checks = checkRunsSchema.parse(
        await this.json(`${base}/commits/${pull.head.sha}/check-runs?per_page=100`),
      );

      const evidence = {
        repository: entry.repository,
        number: entry.number,
        state: pull.state,
        isMerged: pull.merged === true,
        createdAt: pull.created_at,
        mergedAt: pull.merged_at ?? pull.created_at,
        headSha: pull.head.sha,
        baseRef: pull.base.ref,
        commits: commits.map((commit) => ({
          sha: commit.sha,
          messageFirstLine: commit.commit.message.split('\n')[0] ?? '',
        })),
        changedFiles: files.map((file) => ({
          path: file.filename,
          additions: file.additions,
          deletions: file.deletions,
        })),
        checkRuns: summariseCheckRuns(checks.check_runs),
        // Deliberately empty. Resolving genuinely linked issues needs a further query per
        // candidate, and guessing them from the body would defeat the admissibility rule that
        // uses this list: a body citing #N would then always "know" N. Empty makes the filter
        // strictly conservative — it over-excludes candidates, and never admits one it should not.
        linkedReferences: [] as number[],
      } as unknown as JevEvidence;

      return { report: pull.body ?? '', evidence, archived: repository.archived === true };
    } catch (error) {
      // A refusal that exhausted the retry budget is a fatal outcome for the whole run, not a
      // verdict about this one candidate: swallowing it here would read as "unreadable" and the
      // selection loop would burn through the rest of the pool tripping the same limit again.
      if (error instanceof Error && error.message.startsWith('not_run:')) throw error;
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// The persuasive rewrite, over the Anthropic Messages API
// ---------------------------------------------------------------------------

export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';

export interface JevRewriter {
  rewrite(prompt: string): Promise<string>;
}

const messagesResponseSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});

export function resolveRewriteApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env[JEV_REWRITE_API_KEY_ENV];
  if (!key || key.trim().length === 0) throw new Error('not_run: missing_rewrite_api_key');
  return key;
}

/** One user message, no `temperature` (errata 3, 2026-09-20), the frozen prompt. The key is held
 *  in memory and nowhere else. */
export class AnthropicRewriter implements JevRewriter {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { apiKey: string; fetchImpl?: typeof fetch }) {
    if (!options.apiKey) throw new Error('not_run: missing_rewrite_api_key');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async rewrite(prompt: string): Promise<string> {
    const response = await this.fetchImpl(ANTHROPIC_MESSAGES_URL, {
      method: 'POST',
      headers: {
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
      },
      // Errata 3 (2026-09-20): no `temperature` key — the vendor rejects it for this model.
      body: JSON.stringify({
        model: JEV_REWRITE_MODEL_ID,
        max_tokens: JEV_REWRITE_MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!response.ok) {
      // The body is not interpolated: it can echo the request, and the request carries no secret,
      // but the status is the whole diagnosis and the body is not worth the risk.
      throw new Error(`rewrite_http_error:${response.status}`);
    }
    const parsed = messagesResponseSchema.parse(await response.json());
    const text = parsed.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');
    if (text.trim().length === 0) throw new Error('rewrite_empty_response');
    return text;
  }
}

// ---------------------------------------------------------------------------
// Frame-exclusion leakage guard
// ---------------------------------------------------------------------------

/**
 * Refuses if any exclusion entry appears in the bytes about to be written.
 *
 * The entry itself is never named in the error. A guard that reported
 * `leaked: private-org/private-repo` would publish the very value it exists to withhold, into a
 * stack trace, a CI log, and whatever collects them.
 */
export function assertNoFrameLeakage(
  text: string,
  exclusions: ReadonlySet<string>,
  where: string,
): void {
  if (containsFrameExclusion(text, exclusions)) {
    throw new Error(`not_run: frame_exclusion_leaked_into_output:${where}`);
  }
}

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------

export interface BuildCorpusOptions {
  repoRoot: string;
  reader: GitHubReader;
  rewriter: JevRewriter;
  env?: NodeJS.ProcessEnv;
  force?: boolean;
  target?: number;
  now?: () => Date;
  onProgress?: (message: string) => void;
  /** Re-runs the search instead of reading the frozen `tmp/jev-judge/pool.json`. */
  refetchPool?: boolean;
}

export interface BuildCorpusResult {
  corpusPath: string;
  manifestPath: string;
  manifest: JevCorpusManifest;
  counts: CaseCounts;
  /** How many entries the exclusion list held. The entries themselves are never returned. */
  frameExclusionCount: number;
  droppedVariants: JevCorpus['droppedVariants'];
}

export async function buildJevCorpus(options: BuildCorpusOptions): Promise<BuildCorpusResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const progress = options.onProgress ?? (() => {});

  // First, before any disk write, any request, and even the frame-exclusion check: the pool now
  // has a segment whose sole authority is errata 1, selection now applies rule 12 on the sole
  // authority of errata 2, and the rewrite request omits `temperature` on the sole authority of
  // errata 3. A build that could not resolve the commit that landed any of them would be citing
  // an authority it never verified existed.
  const erratum1 = assertErratumFrozen(options.repoRoot, JEV_ERRATA_2026_09_20_PATH);
  const erratum2 = assertErratumFrozen(options.repoRoot, JEV_ERRATA_2_2026_09_20_PATH);
  const erratum3 = assertErratumFrozen(options.repoRoot, JEV_ERRATA_3_2026_09_20_PATH);

  // Before any disk write and before any request: an unconfigured exclusion list refuses the
  // build. It never defaults to the empty set, because empty and unconfigured are indistinguishable
  // at the call site and the second one publishes a frame member.
  const frameExclusions = readFrameExclusions(env);

  const paths = corpusFilePaths(options.repoRoot);
  if (existsSync(paths.manifest) && options.force !== true) {
    throw new Error('not_run: corpus_already_built:pass_--force_to_overwrite');
  }
  const forced = existsSync(paths.manifest) && options.force === true;

  progress(`selecting base cases (frame exclusions loaded: ${frameExclusions.size})`);
  const selection = await selectBaseCases({
    reader: options.reader,
    frameExclusions,
    target: options.target,
    repoRoot: options.repoRoot,
    refetchPool: options.refetchPool,
    onProgress: progress,
    now,
    env,
  });
  progress(
    `selected ${selection.baseCases.length} base cases from a pool of ${selection.poolSize}`,
  );

  const cases: JevCase[] = [];
  const droppedVariants: JevCorpus['droppedVariants'] = [];

  for (const base of selection.baseCases) {
    const plain = constructPlainCases(base);
    cases.push(...plain.cases);
    droppedVariants.push(...plain.dropped);

    for (const subject of plain.cases) {
      if (subject.arm !== 'plain' || subject.falseClaim === null || subject.variant === null) {
        continue;
      }
      const rewritten = await rewriteWithRetries(
        options.rewriter,
        buildRewritePrompt(subject.falseClaim, subject.report),
      );
      if (!rewritten.ok) {
        droppedVariants.push({
          baseCaseId: subject.baseCaseId,
          variant: subject.variant as JevVariant,
          arm: 'persuasive',
          reason: rewritten.reason,
        });
        continue;
      }
      const acceptance = acceptanceReason(subject.report, rewritten.text, subject.falseClaim);
      if (acceptance !== null) {
        droppedVariants.push({
          baseCaseId: subject.baseCaseId,
          variant: subject.variant as JevVariant,
          arm: 'persuasive',
          reason: acceptance,
        });
        continue;
      }
      cases.push(persuasiveCase(subject, rewritten.text));
    }
    const arms = caseCountsFromCases(cases);
    progress(
      `${base.baseCaseId}: clean=${arms.clean} plain=${arms.plain} ` +
        `persuasive=${arms.persuasive} total=${cases.length}`,
    );
  }

  // An arm that never produced a single case is a refusal, not a corpus: a partial persuasive arm
  // still builds (the shortfall is the result write-up's to judge against the preregistration's
  // floor), but zero is never silently written. Named by the reason that sank it most often, so
  // the refusal itself is diagnostic rather than generic.
  if (caseCountsFromCases(cases).persuasive === 0) {
    throw new Error(
      `not_run: persuasive_arm_empty:${dominantPersuasiveDropReason(droppedVariants)}`,
    );
  }

  const corpus = jevCorpusSchema.parse({
    protocolVersion: JEV_PROTOCOL_VERSION,
    selectionSeed: JEV_SELECTION_SEED,
    builtAt: now().toISOString(),
    rewriteModel: JEV_REWRITE_MODEL_ID,
    rewritePromptDigest: JEV_REWRITE_PROMPT_DIGEST,
    // The same constant `AnthropicRewriter.rewrite` sends as `max_tokens`; `temperature` is `null`
    // because errata 3 omits the key from the request rather than sending it as zero.
    rewriteParameters: { maxTokens: JEV_REWRITE_MAX_TOKENS, temperature: null },
    selection: {
      query: JEV_SELECTION_QUERY,
      poolSize: selection.poolSize,
      // Counts only. The frame-exclusion rule contributes an integer under `frame_member`, and
      // nothing that could be inverted back into a membership list.
      exclusionCounts: selection.exclusionCounts,
      selected: selection.selected,
    },
    droppedVariants,
    cases,
  });

  const corpusBytes = `${canonicalJson(corpus)}\n`;
  const manifestOptions: BuildManifestOptions = {
    forced,
    poolRefetched: selection.poolRefetched,
    segments: selection.segments.map((segment) => ({
      id: segment.id,
      query: segment.query,
      sort: segment.sort,
      order: segment.order,
      pageCount: segment.pageCount,
      entryCount: segment.entryCount,
      duplicateCount: segment.duplicateCount,
      admittedCount: segment.admittedCount,
      authorisedBy: segment.authorisedBy,
    })),
    errata: [erratum1, erratum2, erratum3],
    frameExclusionCount: frameExclusions.size,
  };
  const manifest = buildManifest(corpus, corpusBytes, manifestOptions);
  const manifestBytes = `${canonicalJson(manifest)}\n`;

  // Both artifacts are checked before either is written, so a refusal leaves no half-written pair.
  assertNoFrameLeakage(corpusBytes, frameExclusions, 'corpus');
  assertNoFrameLeakage(manifestBytes, frameExclusions, 'manifest');

  mkdirSync(dirname(paths.corpus), { recursive: true });
  writeFileSync(paths.corpus, corpusBytes);
  writeFileSync(paths.manifest, manifestBytes);

  const counts = realizedCaseCounts(corpus);
  progress(
    `wrote clean=${counts.clean} plain_defective=${counts.plain} ` +
      `persuasive_defective=${counts.persuasive} total=${counts.total} ` +
      `dropped=${droppedVariants.length}`,
  );

  return {
    corpusPath: paths.corpus,
    manifestPath: paths.manifest,
    manifest,
    counts,
    frameExclusionCount: frameExclusions.size,
    droppedVariants,
  };
}

type RewriteOutcome = { ok: true; text: string } | { ok: false; reason: string };

/**
 * Classifies a rewrite-transport failure into the class the drop record keeps, never the body and
 * never the key. `AnthropicRewriter` throws `rewrite_http_error:<status>` and
 * `rewrite_empty_response` itself; a response schema mismatch surfaces as a `ZodError` from
 * `messagesResponseSchema.parse`, classified here rather than left as an opaque transport failure.
 * Anything else — a network error, a timeout — falls back to `rewrite_transport_failed`.
 */
function classifyRewriteError(error: unknown): string {
  if (error instanceof z.ZodError) return 'rewrite_schema_error';
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('rewrite_http_error:') || message === 'rewrite_empty_response') {
    return message;
  }
  return 'rewrite_transport_failed';
}

/**
 * `rewrite_http_error:<status>` is deterministic on the request that produced it: the call is one
 * user message with a frozen prompt, so a 400/401/403/404/... will fail identically on retry, and
 * retrying it is what "later: jev-judge: rewriteWithRetries retries non-retryable 4xx" named — one
 * loud, cheap failure turned into three quiet, billed ones. `429` (rate limited) and `5xx`
 * (vendor-side) are transient and worth a second attempt, same as a bare transport failure.
 */
function isRetryableRewriteReason(reason: string): boolean {
  if (reason === 'rewrite_transport_failed') return true;
  const status = Number(reason.slice('rewrite_http_error:'.length));
  if (!reason.startsWith('rewrite_http_error:') || !Number.isInteger(status)) return false;
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Retries the TRANSPORT only, and only when the failure class is retryable (see
 * `isRetryableRewriteReason`). A rewrite that came back and failed `acceptRewrite` is not retried:
 * the call sends no `temperature` (errata 3) with one user message, so the second attempt asks the
 * identical question and the retry would be theatre that inflates the spend and the apparent
 * effort. On exhaustion, the LAST attempt's error class survives into the drop record — a bare
 * catch here would discard the one fact (401 vs. a transport blip) that tells the operator what to
 * fix.
 */
async function rewriteWithRetries(rewriter: JevRewriter, prompt: string): Promise<RewriteOutcome> {
  let reason = 'rewrite_transport_failed';
  for (let attempt = 1; attempt <= JEV_REWRITE_MAX_ATTEMPTS; attempt += 1) {
    try {
      return { ok: true, text: await rewriter.rewrite(prompt) };
    } catch (error) {
      reason = classifyRewriteError(error);
      if (attempt === JEV_REWRITE_MAX_ATTEMPTS || !isRetryableRewriteReason(reason)) {
        return { ok: false, reason };
      }
    }
  }
  return { ok: false, reason };
}

function acceptanceReason(original: string, rewritten: string, falseClaim: string): string | null {
  const acceptance = acceptRewrite(original, rewritten, falseClaim);
  return acceptance.ok ? null : acceptance.reason;
}

/** The most frequent drop reason among the persuasive arm's dropped variants, so an empty-arm
 * refusal names what actually sank it rather than a generic `persuasive_arm_empty`. Ties keep
 * whichever reason was seen first, for a deterministic message. */
function dominantPersuasiveDropReason(droppedVariants: JevCorpus['droppedVariants']): string {
  const counts = new Map<string, number>();
  for (const dropped of droppedVariants) {
    if (dropped.arm !== 'persuasive') continue;
    counts.set(dropped.reason, (counts.get(dropped.reason) ?? 0) + 1);
  }
  let dominant: string | null = null;
  let max = 0;
  for (const [reason, count] of counts) {
    if (count > max) {
      dominant = reason;
      max = count;
    }
  }
  return dominant ?? 'no_persuasive_variants_attempted';
}
