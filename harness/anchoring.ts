/**
 * Anchoring mechanism test for the Jev judge scope_mismatch false-clear rate.
 *
 * `docs/experiments/jev-judge-calibration-result-2026-09-20.md` found scope_mismatch false-clearing
 * MORE often with the evidence in context (E, plain arm: 92.0%) than without it (T, plain arm:
 * 62.0%), with no mechanism offered. This module tests one proposed mechanism — the model anchors
 * on "the evidence is large and full of files" rather than checking specific set membership — by
 * rendering the same 150 cases (100 scope_mismatch, 50 clean) four different ways and measuring
 * whether shrinking or repositioning the changed-file list moves the false-clear rate. The
 * preregistration is `docs/experiments/jev-judge-anchoring-preregistration-2026-09-22.md`.
 *
 * This module owns no write path into `constants.ts`, `corpus.ts`, `metrics.ts` or `runner.ts` —
 * all four are frozen source for the primary experiment and stay untouched. Every renderer below is
 * a pure function of one `JevCase`; the frozen `renderState` is reused unchanged for Arm 0, and a
 * handful of small statistics helpers are duplicated locally (never imported unexported) because
 * `corpus.ts` and `metrics.ts` do not export the private functions this module needs
 * (`sortKeys`, `clusterBootstrap`, `percentileInterval`, `cellRefusals` and the threshold-verdict
 * helpers in `publish.ts`). Duplicating six small pure functions is cheaper than editing frozen
 * source to export them mid-experiment.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { z } from 'zod';

import { wilsonInterval } from '../in-scope-cejel-recall-v4/report.js';
import { JevClient, type JevRequest, choiceLabel, noulProbability } from './client.js';
import {
  JEV_BASE_URL_ENV,
  JEV_BOOTSTRAP_RESAMPLES,
  JEV_CHOICE_INSTRUCTIONS,
  JEV_CHOICE_LABELS,
  JEV_COST_OVERRUN_ABORT_MULTIPLE,
  JEV_DECISION_THRESHOLD,
  JEV_MODEL_ID,
  JEV_PRICE_PER_MILLION_INPUT_TOKENS,
  JEV_TOKEN_BUDGET_BY_CONDITION,
  type JevArm,
  type JevChoiceLabel,
  type JevVariant,
} from './constants.js';
import {
  type JevCase,
  type JevCorpus,
  type JevEvidence,
  choiceCriteria,
  loadFrozenCorpus,
  nulQuestion,
  renderState,
  sha256Hex,
} from './corpus.js';
import { type WilsonInterval, createRandom } from './metrics.js';
import type { PreregistrationBinding } from './runner.js';
import {
  assertCleanWorktree,
  estimateTokens,
  resolveApiKey,
  resolveJevRepoRoot,
} from './runner.js';

export type { WilsonInterval };

// ---------------------------------------------------------------------------
// Frozen for this experiment
// ---------------------------------------------------------------------------

export const JEV_ANCHORING_PREREGISTRATION_PATH =
  'docs/experiments/jev-judge-anchoring-preregistration-2026-09-22.md';

export const JEV_ANCHORING_ARMS = [0, 1, 2, 3] as const;
export type AnchoringArm = (typeof JEV_ANCHORING_ARMS)[number];

export const JEV_ANCHORING_ARM_LABELS: Record<AnchoringArm, string> = {
  0: 'replication (primary E rendering unchanged)',
  1: 'list first (full evidence, changed-file list moved to the top of the evidence)',
  2: 'list only (evidence reduced to the changed-file list)',
  3: 'list only, false path adjacent (report truncated to the paragraph naming the false path)',
};

// ---------------------------------------------------------------------------
// Small helpers duplicated from frozen source
//
// `sortKeys` (corpus.ts) and `percentileInterval`/`clusterBootstrap`/`cellRefusals` (metrics.ts)
// and the threshold-verdict helpers (publish.ts) are not exported, and none of those four files
// may be edited to export them: they are frozen source for the primary experiment. Each duplicate
// below is under ten lines.
// ---------------------------------------------------------------------------

function deepSortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepSortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => [key, deepSortKeys(entry)]),
  );
}

export interface Interval {
  lower: number;
  upper: number;
}

function percentileInterval(samples: number[]): Interval {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))] ??
    Number.NaN;
  return { lower: at(0.025), upper: at(0.975) };
}

function cellRefusals(numerator: number, denominator: number, cell: string): string[] {
  if (denominator === 0) return [`cell_empty:${cell}`];
  if (numerator === 0) return [`possible_construction_leakage:${cell}`];
  if (numerator === denominator) return [`cell_rate_is_perfect:${cell}`];
  return [];
}

export type AnchoringVerdict = 'supported' | 'contradicted' | 'not_evaluable';

function atMostVerdict(interval: Interval, threshold: number): AnchoringVerdict {
  if (interval.upper <= threshold) return 'supported';
  if (interval.lower > threshold) return 'contradicted';
  return 'not_evaluable';
}

function combineVerdicts(verdicts: readonly AnchoringVerdict[]): AnchoringVerdict {
  if (verdicts.includes('contradicted')) return 'contradicted';
  if (verdicts.includes('not_evaluable')) return 'not_evaluable';
  return 'supported';
}

// ---------------------------------------------------------------------------
// Renderers — each one a pure function of (subject), fixture-tested byte for byte
// ---------------------------------------------------------------------------

/** Arm 0: the primary's E rendering, unchanged. Calls the frozen `renderState` directly rather
 * than reimplementing it, so Arm 0 cannot drift from what the primary actually sent. */
export function renderArm0State(subject: JevCase): string {
  return renderState('E', subject);
}

/** The evidence JSON, with `changedFiles` serialised first and every other key alphabetical after
 * it — the same canonicalisation `corpus.ts`'s `canonicalJson` uses, with one key pulled to the
 * front. Reordering a JSON object's keys changes nothing a machine reads structurally; it changes
 * only where in the text a model encounters the changed-file list first. */
function canonicalEvidenceChangedFilesFirst(evidence: JevEvidence): string {
  const { changedFiles, ...rest } = evidence as unknown as Record<string, unknown>;
  const ordered: Record<string, unknown> = { changedFiles: deepSortKeys(changedFiles) };
  Object.assign(ordered, deepSortKeys(rest) as Record<string, unknown>);
  return JSON.stringify(ordered, null, 2);
}

/** Arm 1: list first. Full evidence, nothing removed; `changedFiles` moved to the top of the
 * evidence object instead of sitting alphabetically between `checkRuns` and `commits`. */
export function renderArm1State(subject: JevCase): string {
  return `${subject.report}\n---\nEVIDENCE (JSON):\n${canonicalEvidenceChangedFilesFirst(subject.evidence)}`;
}

interface ReducedChangedFile {
  path: string;
  additions: number;
  deletions: number;
}

function reducedChangedFileList(evidence: JevEvidence): { changedFiles: ReducedChangedFile[] } {
  return {
    changedFiles: evidence.changedFiles.map((file) => ({
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
    })),
  };
}

function canonicalReducedEvidence(evidence: JevEvidence): string {
  return JSON.stringify(deepSortKeys(reducedChangedFileList(evidence)), null, 2);
}

/** Arm 2: list only. Every evidence field except the changed-file list (repository, number,
 * dates, SHAs, commits, check-run summary, linked references) is removed; the report is untouched. */
export function renderArm2State(subject: JevCase): string {
  return `${subject.report}\n---\nEVIDENCE (JSON):\n${canonicalReducedEvidence(subject.evidence)}`;
}

const BACKTICKED_PATH = /`([^`\n]+)`/;

/** The path a scope_mismatch construction names, extracted from the exact sentence
 * `constructVariant` built it from (`` `This change also updates \`<path>\`.` ``). `null` for a
 * clean case, which carries no false claim at all. */
export function extractFalsePath(falseClaim: string | null): string | null {
  if (falseClaim === null) return null;
  return BACKTICKED_PATH.exec(falseClaim)?.[1] ?? null;
}

/**
 * The report paragraph (split on a blank line) that contains the false path, so the claim and the
 * reduced list are the whole context. A clean case has no false path to locate and keeps its full
 * report — there is nothing to be "adjacent" to, and shrinking a clean report would confound the
 * false-flag control with an unrelated truncation. A defective case whose false path is not found
 * in any single paragraph (should not occur by construction, since `constructVariant` always
 * appends the false claim as its own trailing paragraph, but the persuasive rewrite is free-text
 * and is not guaranteed to preserve paragraph boundaries) also keeps its full report rather than
 * silently emitting an empty state.
 */
export function paragraphAdjacentToFalsePath(subject: JevCase): string {
  const falsePath = extractFalsePath(subject.falseClaim);
  if (falsePath === null) return subject.report;
  const paragraphs = subject.report.split(/\n\n+/);
  return paragraphs.find((paragraph) => paragraph.includes(falsePath)) ?? subject.report;
}

/** Arm 3: list only, false path adjacent. As Arm 2, with the report truncated to the one
 * paragraph that names the false path. */
export function renderArm3State(subject: JevCase): string {
  return `${paragraphAdjacentToFalsePath(subject)}\n---\nEVIDENCE (JSON):\n${canonicalReducedEvidence(subject.evidence)}`;
}

export function renderAnchoringState(arm: AnchoringArm, subject: JevCase): string {
  if (arm === 0) return renderArm0State(subject);
  if (arm === 1) return renderArm1State(subject);
  if (arm === 2) return renderArm2State(subject);
  return renderArm3State(subject);
}

/** Noul and Choice questions unchanged from the primary condition E; only `state` varies by arm. */
export function buildAnchoringJevRequest(arm: AnchoringArm, subject: JevCase): JevRequest {
  return {
    state: renderAnchoringState(arm, subject),
    questions: {
      primary: { type: 'noul', instructions: nulQuestion('E') },
      variant: {
        type: 'choice',
        instructions: JEV_CHOICE_INSTRUCTIONS,
        criteria: choiceCriteria(),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Subjects — the 100 scope_mismatch cases (plain and persuasive) and the 50 clean cases
// ---------------------------------------------------------------------------

// Erratum 2026-09-23 (docs/experiments/jev-judge-anchoring-errata-2026-09-23.md): the
// preregistration froze 150 on the assumption of 50 persuasive scope_mismatch cases; the frozen
// corpus manifest records 48 (two rewrites failed the verbatim guard and were dropped, as the
// primary result states). The population is unchanged; only the expected count was wrong. The
// guard fired on the first live attempt (`anchoring_subject_count_unexpected:148`) before any call.
export const JEV_ANCHORING_EXPECTED_SUBJECT_COUNT = 148;

export function selectAnchoringSubjects(corpus: JevCorpus): JevCase[] {
  const scopeMismatch = corpus.cases.filter((entry) => entry.variant === 'scope_mismatch');
  const clean = corpus.cases.filter((entry) => entry.arm === 'clean');
  return [...scopeMismatch, ...clean];
}

// ---------------------------------------------------------------------------
// Ancestor guard — mirrors `assertPreregistrationFrozen` (runner.ts), pointed at this
// experiment's own preregistration path. `runner.ts` is frozen source and its guard is hardcoded
// to the primary's path, so it cannot be reused directly; the two checks are duplicated here
// rather than parameterising frozen code mid-experiment.
// ---------------------------------------------------------------------------

function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

export function assertAnchoringPreregistrationFrozen(repoRoot: string): PreregistrationBinding {
  const path = JEV_ANCHORING_PREREGISTRATION_PATH;
  const firstCommit = git(repoRoot, [
    'log',
    '--reverse',
    '--diff-filter=A',
    '--format=%H',
    '--',
    path,
  ])
    .split('\n')
    .find(Boolean);
  if (!firstCommit) {
    throw new Error('not_run: preregistration_not_ancestor:never_committed');
  }

  const head = git(repoRoot, ['rev-parse', 'HEAD']);
  const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', firstCommit, head], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (ancestry.status !== 0 || firstCommit === head) {
    throw new Error(`not_run: preregistration_not_ancestor:${firstCommit}:${head}`);
  }

  const frozenBlob = git(repoRoot, ['rev-parse', `${firstCommit}:${path}`]);
  const workingBlob = git(repoRoot, ['hash-object', path]);
  if (frozenBlob !== workingBlob) {
    throw new Error(
      `not_run: preregistration_modified_after_freeze:frozen=${frozenBlob}:working=${workingBlob}`,
    );
  }

  return { commit: firstCommit, blob: frozenBlob, path };
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

export interface AnchoringCostEstimate {
  callsTotal: number;
  tokensTotal: number;
  totalUsd: number;
}

export function anchoringCostEstimate(subjects: readonly JevCase[]): AnchoringCostEstimate {
  let tokensTotal = 0;
  let callsTotal = 0;
  for (const arm of JEV_ANCHORING_ARMS) {
    for (const subject of subjects) {
      tokensTotal += estimateTokens(renderAnchoringState(arm, subject));
      callsTotal += 1;
    }
  }
  return {
    callsTotal,
    tokensTotal,
    totalUsd: (tokensTotal * JEV_PRICE_PER_MILLION_INPUT_TOKENS) / 1_000_000,
  };
}

/** The frozen budget is the primary's per-call E budget, times one call per subject per arm: every
 * arm here is at most as large as the unmodified E rendering, so this is already a generous
 * ceiling. Reuses `JEV_COST_OVERRUN_ABORT_MULTIPLE` from `constants.ts` unchanged. */
export function assertAnchoringCostWithinBudget(subjects: readonly JevCase[]): {
  budgetTokens: number;
  actual: AnchoringCostEstimate;
} {
  const budgetTokens =
    subjects.length * JEV_ANCHORING_ARMS.length * JEV_TOKEN_BUDGET_BY_CONDITION.E;
  const actual = anchoringCostEstimate(subjects);
  if (actual.tokensTotal > budgetTokens * JEV_COST_OVERRUN_ABORT_MULTIPLE) {
    throw new Error(
      `not_run: cost_estimate_exceeds_budget:budget_tokens=${budgetTokens}:actual_tokens=${actual.tokensTotal}`,
    );
  }
  return { budgetTokens, actual };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface AnchoringObservation {
  caseId: string;
  baseCaseId: string;
  arm: AnchoringArm;
  caseArm: JevArm;
  variant: JevVariant | null;
  oracleAccurate: 0 | 1;
  noul: number;
  choice: JevChoiceLabel | null;
  inputTokens: number | null;
}

export interface AnchoringArmStats {
  arm: AnchoringArm;
  calls: number;
  meanInputTokens: number | null;
  estimatedInputTokens: number;
  estimatedUsd: number;
  wallClockMs: number;
  callLogPath: string;
  callLogDigest: string;
}

export interface AnchoringRun {
  protocolVersion: string;
  model: string;
  preregistrationCommit: string;
  preregistrationBlob: string;
  harnessCommit: string;
  corpusDigest: string;
  startedAt: string;
  completedAt: string;
  costEstimate: { budgetTokens: number; actualTokens: number; totalUsd: number };
  armStats: AnchoringArmStats[];
  observations: AnchoringObservation[];
}

export interface RunAnchoringOptions {
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  /** Offline fixture path only. Production leaves this unset and one real client per arm is
   * constructed, each with its own call-log file. */
  client?: Pick<JevClient, 'call'>;
  outDir: string;
  now?: () => Date;
  onProgress?: (message: string) => void;
  /** Escape hatch for the offline fixture test only; production passes nothing. */
  requireCleanWorktree?: boolean;
  /** Escape hatch for the offline fixture test only, which runs against a small synthetic corpus
   * rather than the real 150-subject one; production passes nothing and the frozen 150 applies. */
  expectedSubjectCount?: number;
}

export async function runAnchoringExperiment(options: RunAnchoringOptions): Promise<AnchoringRun> {
  const repoRoot = resolveJevRepoRoot(options.repoRoot);
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());

  const preregistration = assertAnchoringPreregistrationFrozen(repoRoot);
  const outputPrefix = relative(repoRoot, resolve(options.outDir));
  if (options.requireCleanWorktree !== false) {
    assertCleanWorktree(
      repoRoot,
      outputPrefix.startsWith('..') || outputPrefix === '' ? undefined : outputPrefix,
    );
  }
  const harnessCommit = git(repoRoot, ['rev-parse', 'HEAD']);

  // Resolved once, before the corpus is read, and only on the live path — the injected client is
  // the offline fixture route and makes no request, so it resolves no key. Mirrors runner.ts.
  const apiKey = options.client ? undefined : resolveApiKey(env);

  const loaded = loadFrozenCorpus(repoRoot);
  const subjects = selectAnchoringSubjects(loaded.corpus);
  const expectedSubjectCount = options.expectedSubjectCount ?? JEV_ANCHORING_EXPECTED_SUBJECT_COUNT;
  if (subjects.length !== expectedSubjectCount) {
    throw new Error(`not_run: anchoring_subject_count_unexpected:${subjects.length}`);
  }
  const cost = assertAnchoringCostWithinBudget(subjects);

  const startedAt = now().toISOString();
  const observations: AnchoringObservation[] = [];
  const armStats: AnchoringArmStats[] = [];

  for (const arm of JEV_ANCHORING_ARMS) {
    const callLogPath = join(options.outDir, `calls-arm${arm}.jsonl`);
    const client =
      options.client ??
      new JevClient({
        apiKey: apiKey as string,
        baseUrl: env[JEV_BASE_URL_ENV],
        logPath: callLogPath,
        now,
      });

    const armStartedAtMs = now().getTime();
    let observedTokenTotal = 0;
    let observedTokenCount = 0;

    for (const subject of subjects) {
      const callId = `${subject.caseId}|arm${arm}`;
      const result = await client.call(callId, buildAnchoringJevRequest(arm, subject));

      if (result.response.model !== JEV_MODEL_ID) {
        throw new Error(
          `not_run: model_mismatch:expected=${JEV_MODEL_ID}:actual=${result.response.model}:call=${callId}`,
        );
      }

      const noul = noulProbability(result.response, 'primary');
      const choice = choiceLabel(result.response, 'variant', JEV_CHOICE_LABELS);
      observations.push({
        caseId: callId,
        baseCaseId: subject.baseCaseId,
        arm,
        caseArm: subject.arm,
        variant: subject.variant,
        oracleAccurate: subject.oracleAccurate,
        noul,
        choice,
        inputTokens: result.inputTokens,
      });
      if (result.inputTokens !== null) {
        observedTokenTotal += result.inputTokens;
        observedTokenCount += 1;
      }
      options.onProgress?.(`${callId} noul=${noul}`);
    }

    const estimatedInputTokens = subjects.reduce(
      (sum, subject) => sum + estimateTokens(renderAnchoringState(arm, subject)),
      0,
    );
    armStats.push({
      arm,
      calls: subjects.length,
      meanInputTokens: observedTokenCount === 0 ? null : observedTokenTotal / observedTokenCount,
      estimatedInputTokens,
      estimatedUsd: (estimatedInputTokens * JEV_PRICE_PER_MILLION_INPUT_TOKENS) / 1_000_000,
      wallClockMs: now().getTime() - armStartedAtMs,
      callLogPath,
      callLogDigest: sha256Hex(existsSync(callLogPath) ? readFileSync(callLogPath, 'utf8') : ''),
    });
  }

  return anchoringRunSchema.parse({
    protocolVersion: loaded.corpus.protocolVersion,
    model: JEV_MODEL_ID,
    preregistrationCommit: preregistration.commit,
    preregistrationBlob: preregistration.blob,
    harnessCommit,
    corpusDigest: loaded.sha256,
    startedAt,
    completedAt: now().toISOString(),
    costEstimate: {
      budgetTokens: cost.budgetTokens,
      actualTokens: cost.actual.tokensTotal,
      totalUsd: cost.actual.totalUsd,
    },
    armStats,
    observations,
  });
}

export const anchoringRunSchema = z
  .object({
    protocolVersion: z.string().min(1),
    model: z.literal(JEV_MODEL_ID),
    preregistrationCommit: z.string().regex(/^[a-f0-9]{40}$/),
    preregistrationBlob: z.string().regex(/^[a-f0-9]{40}$/),
    harnessCommit: z.string().regex(/^[a-f0-9]{40}$/),
    corpusDigest: z.string().regex(/^[0-9a-f]{64}$/),
    startedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }),
    costEstimate: z.object({
      budgetTokens: z.number().int().nonnegative(),
      actualTokens: z.number().int().nonnegative(),
      totalUsd: z.number().nonnegative(),
    }),
    armStats: z.array(
      z
        .object({
          arm: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
          calls: z.number().int().nonnegative(),
          meanInputTokens: z.number().nonnegative().nullable(),
          estimatedInputTokens: z.number().int().nonnegative(),
          estimatedUsd: z.number().nonnegative(),
          wallClockMs: z.number().nonnegative(),
          callLogPath: z.string().min(1),
          callLogDigest: z.string().regex(/^[0-9a-f]{64}$/),
        })
        .strict(),
    ),
    observations: z.array(
      z
        .object({
          caseId: z.string().min(1),
          baseCaseId: z.string().min(1),
          arm: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
          caseArm: z.enum(['clean', 'plain', 'persuasive']),
          variant: z
            .enum(['premature', 'fabricated_reference', 'wrong_count', 'scope_mismatch'])
            .nullable(),
          oracleAccurate: z.union([z.literal(0), z.literal(1)]),
          noul: z.number().min(0).max(1),
          choice: z.enum(JEV_CHOICE_LABELS).nullable(),
          inputTokens: z.number().int().nonnegative().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function rateOf(
  numerator: number,
  denominator: number,
): {
  numerator: number;
  denominator: number;
  rate: number;
  interval: WilsonInterval;
} {
  return {
    numerator,
    denominator,
    rate: numerator / denominator,
    interval: wilsonInterval(numerator, denominator),
  };
}

export interface AnchoringCellRate {
  arm: AnchoringArm;
  caseArm: 'plain' | 'persuasive';
  numerator: number;
  denominator: number;
  rate: number;
  interval: WilsonInterval;
  refusalReasons: string[];
  claimBearing: boolean;
}

/** False-clear on scope_mismatch, per anchoring arm and per case arm (plain / persuasive). The
 * plain cell is this experiment's headline measurement: the primary's 92.0% false-clear rate that
 * motivates it is the plain arm's cell (E:plain:scope_mismatch, n=50) — its persuasive sibling
 * false-cleared at 43.8% on the same run, because the persuasive rewrite embeds the false claim in
 * prose rather than appending it as one line. */
export function anchoringFalseClearTable(
  observations: readonly AnchoringObservation[],
): AnchoringCellRate[] {
  const table: AnchoringCellRate[] = [];
  for (const arm of JEV_ANCHORING_ARMS) {
    for (const caseArm of ['plain', 'persuasive'] as const) {
      const cell = observations.filter(
        (entry) =>
          entry.arm === arm && entry.caseArm === caseArm && entry.variant === 'scope_mismatch',
      );
      const numerator = cell.filter((entry) => entry.noul >= JEV_DECISION_THRESHOLD).length;
      const name = `arm${arm}:${caseArm}:scope_mismatch`;
      const refusalReasons = cellRefusals(numerator, cell.length, name);
      table.push({
        arm,
        caseArm,
        ...(cell.length === 0
          ? { numerator: 0, denominator: 0, rate: Number.NaN, interval: wilsonInterval(0, 1) }
          : rateOf(numerator, cell.length)),
        refusalReasons,
        claimBearing: refusalReasons.length === 0,
      });
    }
  }
  return table;
}

export interface AnchoringFlagRate {
  arm: AnchoringArm;
  numerator: number;
  denominator: number;
  rate: number;
  interval: WilsonInterval;
  refusalReasons: string[];
  claimBearing: boolean;
}

/** False-flag on the 50 clean cases, per anchoring arm — the control for PA-3: a reduction that
 * buys recall by losing precision shows up here, not in the false-clear table. */
export function anchoringFalseFlagTable(
  observations: readonly AnchoringObservation[],
): AnchoringFlagRate[] {
  return JEV_ANCHORING_ARMS.map((arm) => {
    const cell = observations.filter((entry) => entry.arm === arm && entry.caseArm === 'clean');
    const numerator = cell.filter((entry) => entry.noul < JEV_DECISION_THRESHOLD).length;
    const name = `arm${arm}:clean`;
    const refusalReasons = cell.length === 0 ? [`cell_empty:${name}`] : [];
    return {
      arm,
      ...(cell.length === 0
        ? { numerator: 0, denominator: 0, rate: Number.NaN, interval: wilsonInterval(0, 1) }
        : rateOf(numerator, cell.length)),
      refusalReasons,
      claimBearing: refusalReasons.length === 0,
    };
  });
}

export interface AnchoringChoiceAccuracy {
  arm: AnchoringArm;
  numerator: number;
  denominator: number;
  rate: number | null;
  interval: WilsonInterval | null;
}

export function anchoringChoiceAccuracyTable(
  observations: readonly AnchoringObservation[],
): AnchoringChoiceAccuracy[] {
  return JEV_ANCHORING_ARMS.map((arm) => {
    const scoped = observations.filter((entry) => entry.arm === arm && entry.choice !== null);
    const numerator = scoped.filter(
      (entry) => entry.choice === (entry.variant ?? 'accurate'),
    ).length;
    return {
      arm,
      numerator,
      denominator: scoped.length,
      rate: scoped.length === 0 ? null : numerator / scoped.length,
      interval: scoped.length === 0 ? null : wilsonInterval(numerator, scoped.length),
    };
  });
}

function groupByBaseCase(
  observations: readonly AnchoringObservation[],
): Map<string, AnchoringObservation[]> {
  const groups = new Map<string, AnchoringObservation[]>();
  for (const observation of observations) {
    const bucket = groups.get(observation.baseCaseId);
    if (bucket) bucket.push(observation);
    else groups.set(observation.baseCaseId, [observation]);
  }
  return groups;
}

function plainScopeMismatchClearRate(
  sample: readonly AnchoringObservation[],
  arm: AnchoringArm,
): number | null {
  const cell = sample.filter(
    (entry) => entry.arm === arm && entry.caseArm === 'plain' && entry.variant === 'scope_mismatch',
  );
  if (cell.length === 0) return null;
  return cell.filter((entry) => entry.noul >= JEV_DECISION_THRESHOLD).length / cell.length;
}

/**
 * Paired cluster bootstrap over base cases, restricted to the plain scope_mismatch sub-population
 * (one case per base case per arm — a natural 1:1 pairing). Mirrors `metrics.ts`'s
 * `clusterBootstrap` (resample base cases with replacement, not individual observations), reusing
 * its exported seeded PRNG (`createRandom`) so the resampling is deterministic without editing
 * `metrics.ts` to export the private bootstrap driver itself.
 */
export function anchoringRatioInterval(
  observations: readonly AnchoringObservation[],
  numeratorArm: AnchoringArm,
  denominatorArm: AnchoringArm,
  resamples = JEV_BOOTSTRAP_RESAMPLES,
): Interval | null {
  const scoped = observations.filter(
    (entry) =>
      entry.caseArm === 'plain' &&
      entry.variant === 'scope_mismatch' &&
      (entry.arm === numeratorArm || entry.arm === denominatorArm),
  );
  const clusters = [...groupByBaseCase(scoped).values()];
  if (clusters.length < 2) return null;
  const random = createRandom(
    `jev-judge-anchoring-2026-09-22|ratio:${numeratorArm}:${denominatorArm}`,
  );
  const samples: number[] = [];
  for (let draw = 0; draw < resamples; draw += 1) {
    const resampled: AnchoringObservation[] = [];
    for (let pick = 0; pick < clusters.length; pick += 1) {
      resampled.push(...(clusters[Math.floor(random() * clusters.length)] ?? []));
    }
    const numeratorRate = plainScopeMismatchClearRate(resampled, numeratorArm);
    const denominatorRate = plainScopeMismatchClearRate(resampled, denominatorArm);
    if (numeratorRate === null || denominatorRate === null || denominatorRate === 0) continue;
    const value = numeratorRate / denominatorRate;
    if (Number.isFinite(value)) samples.push(value);
  }
  if (samples.length < resamples / 2) return null;
  return percentileInterval(samples);
}

export interface AnchoringRatio {
  numeratorArm: AnchoringArm;
  denominatorArm: AnchoringArm;
  numeratorRate: number;
  denominatorRate: number;
  ratio: number;
  interval: Interval | null;
}

export function anchoringRatio(
  observations: readonly AnchoringObservation[],
  falseClear: readonly AnchoringCellRate[],
  numeratorArm: AnchoringArm,
  denominatorArm: AnchoringArm,
  resamples = JEV_BOOTSTRAP_RESAMPLES,
): AnchoringRatio {
  const numeratorCell = falseClear.find(
    (cell) => cell.arm === numeratorArm && cell.caseArm === 'plain',
  );
  const denominatorCell = falseClear.find(
    (cell) => cell.arm === denominatorArm && cell.caseArm === 'plain',
  );
  const numeratorRate = numeratorCell?.rate ?? Number.NaN;
  const denominatorRate = denominatorCell?.rate ?? Number.NaN;
  return {
    numeratorArm,
    denominatorArm,
    numeratorRate,
    denominatorRate,
    ratio: numeratorRate / denominatorRate,
    interval: anchoringRatioInterval(observations, numeratorArm, denominatorArm, resamples),
  };
}

export interface AnchoringMetrics {
  falseClear: AnchoringCellRate[];
  falseFlag: AnchoringFlagRate[];
  choiceAccuracy: AnchoringChoiceAccuracy[];
  sizeRatios: { arm2OverArm0: AnchoringRatio; arm3OverArm0: AnchoringRatio };
  positionRatio: AnchoringRatio;
  observations: number;
  baseCases: number;
}

export function computeAnchoringMetrics(
  observations: readonly AnchoringObservation[],
  resamples = JEV_BOOTSTRAP_RESAMPLES,
): AnchoringMetrics {
  const falseClear = anchoringFalseClearTable(observations);
  return {
    falseClear,
    falseFlag: anchoringFalseFlagTable(observations),
    choiceAccuracy: anchoringChoiceAccuracyTable(observations),
    sizeRatios: {
      arm2OverArm0: anchoringRatio(observations, falseClear, 2, 0, resamples),
      arm3OverArm0: anchoringRatio(observations, falseClear, 3, 0, resamples),
    },
    positionRatio: anchoringRatio(observations, falseClear, 1, 0, resamples),
    observations: observations.length,
    baseCases: groupByBaseCase(observations).size,
  };
}

// ---------------------------------------------------------------------------
// Predictions
// ---------------------------------------------------------------------------

export type AnchoringPredictionVerdict = AnchoringVerdict | 'not_interpreted_replication_failed';

export interface AnchoringScoredPrediction {
  id: 'PA-0' | 'PA-1' | 'PA-2' | 'PA-3';
  statement: string;
  verdict: AnchoringPredictionVerdict;
  measured: string;
}

function pct(value: number): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : 'n/a';
}

/** The primary's E:plain:scope_mismatch cell (`jev-judge-calibration-result-2026-09-20.md`),
 * frozen here as the comparison target for PA-0: 46/50, 92.0%, 95% Wilson [81.2%, 96.8%]. */
export const JEV_PRIMARY_PLAIN_SCOPE_MISMATCH_E = {
  numerator: 46,
  denominator: 50,
  rate: 0.92,
  interval: { lower: 0.812, upper: 0.968 },
} as const;

export function scoreAnchoringPredictions(metrics: AnchoringMetrics): AnchoringScoredPrediction[] {
  const arm0 = metrics.falseClear.find((cell) => cell.arm === 0 && cell.caseArm === 'plain');

  const pa0Verdict: AnchoringVerdict = arm0?.claimBearing
    ? arm0.rate >= JEV_PRIMARY_PLAIN_SCOPE_MISMATCH_E.interval.lower &&
      arm0.rate <= JEV_PRIMARY_PLAIN_SCOPE_MISMATCH_E.interval.upper
      ? 'supported'
      : 'contradicted'
    : 'not_evaluable';
  const pa0: AnchoringScoredPrediction = {
    id: 'PA-0',
    statement:
      "Arm 0 reproduces the primary's scope_mismatch false-clear rate (E, plain, n=50) within its Wilson interval.",
    verdict: pa0Verdict,
    measured: `arm0=${arm0 ? pct(arm0.rate) : 'n/a'} [${pct(JEV_PRIMARY_PLAIN_SCOPE_MISMATCH_E.interval.lower)}, ${pct(JEV_PRIMARY_PLAIN_SCOPE_MISMATCH_E.interval.upper)}] target-n=${JEV_PRIMARY_PLAIN_SCOPE_MISMATCH_E.denominator}`,
  };

  const replicationFailed = pa0Verdict !== 'supported';

  const sizeVerdicts: AnchoringVerdict[] = [
    metrics.sizeRatios.arm2OverArm0.interval
      ? atMostVerdict(metrics.sizeRatios.arm2OverArm0.interval, 0.5)
      : 'not_evaluable',
    metrics.sizeRatios.arm3OverArm0.interval
      ? atMostVerdict(metrics.sizeRatios.arm3OverArm0.interval, 0.25)
      : 'not_evaluable',
  ];
  const pa1: AnchoringScoredPrediction = {
    id: 'PA-1',
    statement:
      "If the mechanism is anchoring on evidence size, Arm 2 false-clears at most half of Arm 0's rate, and Arm 3 at most a quarter.",
    verdict: replicationFailed
      ? 'not_interpreted_replication_failed'
      : combineVerdicts(sizeVerdicts),
    measured: `arm2/arm0=${metrics.sizeRatios.arm2OverArm0.ratio.toFixed(3)}${metrics.sizeRatios.arm2OverArm0.interval ? ` [${metrics.sizeRatios.arm2OverArm0.interval.lower.toFixed(3)}, ${metrics.sizeRatios.arm2OverArm0.interval.upper.toFixed(3)}]` : ' [interval unavailable]'}; arm3/arm0=${metrics.sizeRatios.arm3OverArm0.ratio.toFixed(3)}${metrics.sizeRatios.arm3OverArm0.interval ? ` [${metrics.sizeRatios.arm3OverArm0.interval.lower.toFixed(3)}, ${metrics.sizeRatios.arm3OverArm0.interval.upper.toFixed(3)}]` : ' [interval unavailable]'}`,
  };

  const positionVerdict: AnchoringVerdict = metrics.positionRatio.interval
    ? atMostVerdict(metrics.positionRatio.interval, 0.5)
    : 'not_evaluable';
  const pa2: AnchoringScoredPrediction = {
    id: 'PA-2',
    statement: "If the mechanism is position, Arm 1 false-clears at most half of Arm 0's rate.",
    verdict: replicationFailed ? 'not_interpreted_replication_failed' : positionVerdict,
    measured: `arm1/arm0=${metrics.positionRatio.ratio.toFixed(3)}${metrics.positionRatio.interval ? ` [${metrics.positionRatio.interval.lower.toFixed(3)}, ${metrics.positionRatio.interval.upper.toFixed(3)}]` : ' [interval unavailable]'}`,
  };

  const pa3Verdicts = JEV_ANCHORING_ARMS.map((arm) => {
    const cell = metrics.falseFlag.find((entry) => entry.arm === arm);
    if (!cell || !cell.claimBearing) return 'not_evaluable' as AnchoringVerdict;
    return atMostVerdict(cell.interval, 0.1);
  });
  const pa3: AnchoringScoredPrediction = {
    id: 'PA-3',
    statement: 'The clean false-flag rate does not rise above 10% in any arm.',
    verdict: combineVerdicts(pa3Verdicts),
    measured: JEV_ANCHORING_ARMS.map((arm) => {
      const cell = metrics.falseFlag.find((entry) => entry.arm === arm);
      return `arm${arm}=${cell?.claimBearing ? pct(cell.rate) : 'WITHHELD'}`;
    }).join('; '),
  };

  return [pa0, pa1, pa2, pa3];
}

// ---------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------

export interface PublishedAnchoringResult {
  json: string;
  markdown: string;
}

export function publishAnchoringResult(
  run: AnchoringRun,
  limitsParagraph: string,
  resamples?: number,
): PublishedAnchoringResult {
  const metrics = computeAnchoringMetrics(run.observations, resamples);
  const predictions = scoreAnchoringPredictions(metrics);

  const json = `${JSON.stringify(
    {
      kind: 'jev_judge_anchoring_mechanism_test',
      preregistration: JEV_ANCHORING_PREREGISTRATION_PATH,
      model: run.model,
      preregistrationCommit: run.preregistrationCommit,
      preregistrationBlob: run.preregistrationBlob,
      harnessCommit: run.harnessCommit,
      corpusDigest: run.corpusDigest,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      costEstimate: run.costEstimate,
      armStats: run.armStats,
      metrics,
      predictions,
    },
    null,
    2,
  )}\n`;

  const armLabelRows = JEV_ANCHORING_ARMS.map(
    (arm) => `| ${arm} | ${JEV_ANCHORING_ARM_LABELS[arm]} |`,
  ).join('\n');

  const armStatsRows = run.armStats
    .map(
      (stats) =>
        `| ${stats.arm} | ${stats.calls} | ${stats.meanInputTokens === null ? 'n/a' : stats.meanInputTokens.toFixed(0)} | ${stats.estimatedInputTokens} | US$${stats.estimatedUsd.toFixed(4)} | ${stats.wallClockMs}ms | \`${stats.callLogDigest}\` |`,
    )
    .join('\n');

  const falseClearRows = metrics.falseClear
    .map(
      (cell) =>
        `| ${cell.arm} | ${cell.caseArm} | ${cell.numerator} | ${cell.denominator} | ${cell.claimBearing ? `${pct(cell.rate)} [${pct(cell.interval.lower)}, ${pct(cell.interval.upper)}]` : 'WITHHELD'} | ${cell.refusalReasons.join('; ') || '—'} |`,
    )
    .join('\n');

  const falseFlagRows = metrics.falseFlag
    .map(
      (cell) =>
        `| ${cell.arm} | ${cell.numerator} | ${cell.denominator} | ${cell.claimBearing ? `${pct(cell.rate)} [${pct(cell.interval.lower)}, ${pct(cell.interval.upper)}]` : 'WITHHELD'} | ${cell.refusalReasons.join('; ') || '—'} |`,
    )
    .join('\n');

  const choiceRows = metrics.choiceAccuracy
    .map(
      (entry) =>
        `| ${entry.arm} | ${entry.numerator} | ${entry.denominator} | ${entry.rate === null ? 'n/a' : pct(entry.rate)} | ${entry.interval ? `[${pct(entry.interval.lower)}, ${pct(entry.interval.upper)}]` : 'n/a'} |`,
    )
    .join('\n');

  const predictionRows = predictions
    .map((prediction) => `| ${prediction.id} | ${prediction.verdict} | ${prediction.measured} |`)
    .join('\n');

  const markdown = `# Jev-judge anchoring mechanism test — scope_mismatch

${limitsParagraph}

This tests one mechanism on one defect class (scope_mismatch) and says nothing about the other
three labels. It measures the anchoring proposal against \`docs/experiments/jev-judge-calibration-result-2026-09-20.md\`'s
E:plain:scope_mismatch cell (46/50, 92.0%) — the one this card exists to explain.

Preregistration: \`${JEV_ANCHORING_PREREGISTRATION_PATH}\`
Preregistration commit: \`${run.preregistrationCommit}\` (blob \`${run.preregistrationBlob}\`)
Harness commit: \`${run.harnessCommit}\`
Corpus digest: \`${run.corpusDigest}\`
Run window: ${run.startedAt} to ${run.completedAt}
Observed cost estimate: US$${run.costEstimate.totalUsd.toFixed(4)} across ${run.costEstimate.actualTokens} tokens
Observations: ${metrics.observations} across ${metrics.baseCases} base cases

## Arms

| Arm | Rendering |
|---|---|
${armLabelRows}

## Per-arm cost and wall-clock

| Arm | Calls | Mean input tokens | Estimated input tokens | Estimated cost | Wall-clock | Call log digest |
|---|---|---|---|---|---|---|
${armStatsRows}

## Scored predictions

A prediction whose replication gate (PA-0) did not pass is reported but marked
\`not_interpreted_replication_failed\` rather than scored — the preregistration states this in
advance rather than deciding after seeing the data.

| Prediction | Verdict | Measured |
|---|---|---|
${predictionRows}

## False-clear rate on scope_mismatch — P(noul ≥ 0.5)

The plain cell (n=50) is the headline measurement; the persuasive cell is reported alongside it but
is not itself scored by PA-0/PA-1/PA-2, which name the plain arm's 92.0% explicitly.

| Arm | Case arm | Cleared | n | Rate [95% Wilson] | Refusal |
|---|---|---|---|---|---|
${falseClearRows}

## False-flag rate on clean cases — P(noul < 0.5)

| Arm | Flagged | n | Rate [95% Wilson] | Refusal |
|---|---|---|---|---|
${falseFlagRows}

## Choice accuracy (secondary)

| Arm | Correct | n | Rate | 95% Wilson |
|---|---|---|---|---|
${choiceRows}

## Limits

This tests one mechanism (anchoring on evidence size and position) on one defect class
(scope_mismatch), on one judge, one version, one question wording. It says nothing about the other
three labels (premature, fabricated_reference, wrong_count), about condition T, or about any judge
other than \`${run.model}\`. A null result here (neither ratio moves) does not establish that no
mechanism exists — only that these two do not, on this corpus.
`;

  return { json, markdown };
}
