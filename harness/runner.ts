/**
 * Runner and guards for the Jev judge calibration experiment.
 *
 * Every refusal here throws before any result file is written, so a refused run leaves no artifact
 * that could later be read as a result. The refusal name is the reason, not a generic failure: an
 * absent key, a drifted corpus and a thawed pre-registration are three different findings.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import { z } from 'zod';

import { JevClient, type JevRequest, choiceLabel, noulProbability } from './client.js';
import {
  JEV_API_KEY_ENV,
  JEV_BASE_URL_ENV,
  JEV_CHOICE_INSTRUCTIONS,
  JEV_CHOICE_LABELS,
  JEV_CONDITIONS,
  JEV_COST_OVERRUN_ABORT_MULTIPLE,
  JEV_FROZEN_SOURCE_PATHS,
  JEV_MODEL_ID,
  JEV_PLANNED_BASE_CASES,
  JEV_PREREGISTRATION_PATH,
  JEV_PRICE_PER_MILLION_INPUT_TOKENS,
  JEV_TOKEN_BUDGET_BY_CONDITION,
  JEV_VARIANTS,
  type JevCondition,
} from './constants.js';
import {
  type CaseCounts,
  type JevCase,
  type JevCorpus,
  type LoadedCorpus,
  choiceCriteria,
  corpusFilePaths,
  loadFrozenCorpus,
  nulQuestion,
  plannedCaseCounts,
  realizedCaseCounts,
  renderState,
  sha256Hex,
} from './corpus.js';
import type { JevObservation } from './metrics.js';

// ---------------------------------------------------------------------------
// Git helpers and the frozen-document guards
// ---------------------------------------------------------------------------

function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

export function resolveJevRepoRoot(cwd = process.cwd()): string {
  return resolve(git(cwd, ['rev-parse', '--show-toplevel']));
}

export interface PreregistrationBinding {
  commit: string;
  blob: string;
  path: string;
}

/**
 * Two separate properties, checked separately:
 *
 *   1. the commit that FIRST ADDED the pre-registration is a strict ancestor of HEAD, so the
 *      document existed before the harness that cites it; and
 *   2. the file's current bytes still hash to its blob at that commit, so it is still the document
 *      that existed.
 *
 * The first-add commit is used rather than the file's latest commit on purpose: resolving the
 * freeze point with `log -1` would let a later touch move the freeze forward, which is the exact
 * thing a pre-registration exists to prevent.
 */
export function assertPreregistrationFrozen(repoRoot: string): PreregistrationBinding {
  const path = JEV_PREREGISTRATION_PATH;
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

export interface ErratumBinding {
  commit: string;
  path: string;
}

/**
 * Resolves the commit that first added an errata document, refusing when it was never committed.
 * Mirrors `assertPreregistrationFrozen`'s first-add resolution, but does not itself verify a GPG
 * signature on that commit: the dispatching agent verifies the signature once, out of band, before
 * any of this code runs (`git log --show-signature --diff-filter=A`). This guard exists so any
 * later run — CLI or otherwise, not just a freshly dispatched agent — still refuses rather than
 * silently building a corpus that cites an errata segment with no landed authority behind it.
 */
export function assertErratumFrozen(repoRoot: string, path: string): ErratumBinding {
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
    throw new Error(`not_run: erratum_not_found:${path}`);
  }
  return { commit: firstCommit, path };
}

export function resolveFrozenSourceBlobs(repoRoot: string, commit: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(JEV_FROZEN_SOURCE_PATHS).map(([name, path]) => [
      name,
      git(repoRoot, ['rev-parse', `${commit}:${path}`]),
    ]),
  );
}

/**
 * The harness commit must describe what ran, so the run refuses on a dirty tree.
 *
 * `allowedPrefix` exempts exactly one path: the output directory the caller named for this run.
 * Without it a leftover call log from a previous run would refuse every subsequent run, and the
 * obvious workaround — dropping the check — would let an edited harness run under a commit that
 * does not contain it. The exemption is one caller-named directory, never a general allowance.
 */
export function assertCleanWorktree(repoRoot: string, allowedPrefix?: string): void {
  const lines = git(repoRoot, ['status', '--short'])
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .filter((line) => {
      if (!allowedPrefix) return true;
      const path = line.slice(3).trim();
      return !(path === allowedPrefix || path.startsWith(`${allowedPrefix}/`));
    });
  if (lines.length > 0) {
    throw new Error(`not_run: dirty_worktree:${lines.join(',')}`);
  }
}

// ---------------------------------------------------------------------------
// Key resolution
// ---------------------------------------------------------------------------

export function resolveApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env[JEV_API_KEY_ENV];
  if (!key || key.trim().length === 0) {
    throw new Error('not_run: missing_api_key');
  }
  return key;
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

export interface CostEstimate {
  source: 'frozen_budget' | 'corpus';
  callsByCondition: Record<JevCondition, number>;
  tokensByCondition: Record<JevCondition, number>;
  totalTokens: number;
  totalUsd: number;
}

/** Four characters per token. Deliberately coarse; the figure it produces is cents. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function budgetCostEstimate(counts: CaseCounts = plannedCaseCounts()): CostEstimate {
  const callsByCondition = { T: counts.total, E: counts.total };
  const tokensByCondition = {
    T: counts.total * JEV_TOKEN_BUDGET_BY_CONDITION.T,
    E: counts.total * JEV_TOKEN_BUDGET_BY_CONDITION.E,
  };
  const totalTokens = tokensByCondition.T + tokensByCondition.E;
  return {
    source: 'frozen_budget',
    callsByCondition,
    tokensByCondition,
    totalTokens,
    totalUsd: (totalTokens * JEV_PRICE_PER_MILLION_INPUT_TOKENS) / 1_000_000,
  };
}

export function corpusCostEstimate(corpus: JevCorpus): CostEstimate {
  const tokensByCondition = { T: 0, E: 0 };
  const callsByCondition = { T: 0, E: 0 };
  for (const subject of corpus.cases) {
    for (const condition of JEV_CONDITIONS) {
      tokensByCondition[condition] += estimateTokens(renderState(condition, subject));
      callsByCondition[condition] += 1;
    }
  }
  const totalTokens = tokensByCondition.T + tokensByCondition.E;
  return {
    source: 'corpus',
    callsByCondition,
    tokensByCondition,
    totalTokens,
    totalUsd: (totalTokens * JEV_PRICE_PER_MILLION_INPUT_TOKENS) / 1_000_000,
  };
}

/**
 * Refuses rather than spends when the corpus turns out far larger than the pre-registered budget.
 * The comparison is against the budget for the same number of cases, so a short corpus cannot
 * make a per-case overrun look acceptable.
 */
export function assertCostWithinBudget(corpus: JevCorpus): {
  budget: CostEstimate;
  actual: CostEstimate;
} {
  const budget = budgetCostEstimate(realizedCaseCounts(corpus));
  const actual = corpusCostEstimate(corpus);
  if (actual.totalTokens > budget.totalTokens * JEV_COST_OVERRUN_ABORT_MULTIPLE) {
    throw new Error(
      `not_run: cost_estimate_exceeds_budget:budget_tokens=${budget.totalTokens}:actual_tokens=${actual.totalTokens}`,
    );
  }
  return { budget, actual };
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

export interface DryRunReport {
  plannedBaseCases: number;
  plannedCounts: CaseCounts;
  plannedCost: CostEstimate;
  corpusPresent: boolean;
  realizedCounts: CaseCounts | null;
  realizedCost: CostEstimate | null;
  corpusDigest: string | null;
  countsMatchPlan: boolean | null;
}

/**
 * Builds and reports the case plan without opening any connection. The planned counts are derived
 * from the base-case target and the variant list, never written down as a literal triple, so
 * adding a fifth construction rule changes the printed plan instead of silently disagreeing with
 * it.
 */
export function dryRun(repoRoot: string): DryRunReport {
  const plannedCounts = plannedCaseCounts(JEV_PLANNED_BASE_CASES);
  const base: DryRunReport = {
    plannedBaseCases: JEV_PLANNED_BASE_CASES,
    plannedCounts,
    plannedCost: budgetCostEstimate(plannedCounts),
    corpusPresent: false,
    realizedCounts: null,
    realizedCost: null,
    corpusDigest: null,
    countsMatchPlan: null,
  };

  let loaded: LoadedCorpus;
  try {
    loaded = loadFrozenCorpus(repoRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return base;
    throw error;
  }

  const realizedCounts = realizedCaseCounts(loaded.corpus);
  return {
    ...base,
    corpusPresent: true,
    realizedCounts,
    realizedCost: corpusCostEstimate(loaded.corpus),
    corpusDigest: loaded.sha256,
    countsMatchPlan:
      realizedCounts.clean === plannedCounts.clean &&
      realizedCounts.plain === plannedCounts.plain &&
      realizedCounts.persuasive === plannedCounts.persuasive,
  };
}

export function renderDryRun(report: DryRunReport): string {
  const lines = [
    'jev-judge --dry-run (no network call made)',
    `planned base cases: ${report.plannedBaseCases}`,
    `planned cases: clean=${report.plannedCounts.clean} plain_defective=${report.plannedCounts.plain} persuasive_defective=${report.plannedCounts.persuasive} total=${report.plannedCounts.total}`,
    `planned calls: ${report.plannedCost.callsByCondition.T + report.plannedCost.callsByCondition.E} (T=${report.plannedCost.callsByCondition.T}, E=${report.plannedCost.callsByCondition.E})`,
    `expected input tokens (frozen budget): ${report.plannedCost.totalTokens}`,
    `expected cost: US$${report.plannedCost.totalUsd.toFixed(4)}`,
  ];

  if (!report.corpusPresent) {
    // Rule 9: name the expected non-zero value rather than letting an absent corpus read as a
    // plan that has already been satisfied.
    lines.push(
      'corpus: NOT BUILT — the figures above are the plan, not a measurement of a built corpus.',
      `next: build the corpus, then this command reports realized counts and asserts they equal ${report.plannedCounts.total}.`,
    );
    return lines.join('\n');
  }

  lines.push(
    `corpus digest: ${report.corpusDigest}`,
    `realized cases: clean=${report.realizedCounts?.clean} plain_defective=${report.realizedCounts?.plain} persuasive_defective=${report.realizedCounts?.persuasive} total=${report.realizedCounts?.total}`,
    `realized input tokens (from corpus state lengths): ${report.realizedCost?.totalTokens}`,
    `realized expected cost: US$${report.realizedCost?.totalUsd.toFixed(4)}`,
    `realized counts match plan: ${report.countsMatchPlan ? 'yes' : 'NO'}`,
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export const jevRunSchema = z
  .object({
    protocolVersion: z.string().min(1),
    model: z.literal(JEV_MODEL_ID),
    preregistrationCommit: z.string().regex(/^[a-f0-9]{40}$/),
    preregistrationBlob: z.string().regex(/^[a-f0-9]{40}$/),
    harnessCommit: z.string().regex(/^[a-f0-9]{40}$/),
    frozenSourceBlobs: z.record(z.string().regex(/^[a-f0-9]{40}$/)),
    corpusDigest: z.string().regex(/^[0-9a-f]{64}$/),
    startedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }),
    callLogPath: z.string().min(1),
    callLogDigest: z.string().regex(/^[0-9a-f]{64}$/),
    costEstimate: z.object({
      budgetTokens: z.number().int().nonnegative(),
      actualTokens: z.number().int().nonnegative(),
      totalUsd: z.number().nonnegative(),
    }),
    modelFieldValues: z.array(z.string()).min(1),
    observations: z.array(
      z
        .object({
          caseId: z.string().min(1),
          baseCaseId: z.string().min(1),
          condition: z.enum(JEV_CONDITIONS),
          arm: z.enum(['clean', 'plain', 'persuasive']),
          variant: z.enum(JEV_VARIANTS).nullable(),
          oracleAccurate: z.union([z.literal(0), z.literal(1)]),
          noul: z.number().min(0).max(1),
          choice: z.enum(JEV_CHOICE_LABELS).nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type JevRun = z.infer<typeof jevRunSchema>;

export interface RunJevOptions {
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  /** Offline fixture path only. Production leaves this unset and a real client is constructed. */
  client?: Pick<JevClient, 'call'>;
  callLogPath: string;
  now?: () => Date;
  onProgress?: (message: string) => void;
  /** Escape hatch for the offline fixture test only; production passes nothing. */
  requireCleanWorktree?: boolean;
}

/**
 * Builds one System One request in the documented shape: a `questions` map keyed by question id.
 *
 * The Choice is present only in `E`. In `T` the map carries `primary` alone, so the text-only
 * condition cannot be handed the evidence-shaped question by accident — the difference between the
 * two conditions is the whole experiment, and it lives here.
 *
 * Extracted from the call site so the golden-request test pins the bytes this function actually
 * produces rather than a copy of it written in the test.
 */
export function buildJevRequest(condition: JevCondition, subject: JevCase): JevRequest {
  return {
    state: renderState(condition, subject),
    questions: {
      primary: { type: 'noul', instructions: nulQuestion(condition) },
      ...(condition === 'E'
        ? {
            variant: {
              type: 'choice' as const,
              instructions: JEV_CHOICE_INSTRUCTIONS,
              criteria: choiceCriteria(),
            },
          }
        : {}),
    },
  };
}

function observationFor(
  subject: JevCase,
  condition: JevCondition,
  noul: number,
  choice: JevObservation['choice'],
): JevObservation {
  return {
    caseId: `${subject.caseId}|${condition}`,
    baseCaseId: subject.baseCaseId,
    condition,
    arm: subject.arm,
    variant: subject.variant,
    oracleAccurate: subject.oracleAccurate,
    noul,
    choice,
  };
}

export async function runJevExperiment(options: RunJevOptions): Promise<JevRun> {
  const repoRoot = resolveJevRepoRoot(options.repoRoot);
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());

  const preregistration = assertPreregistrationFrozen(repoRoot);
  const outputPrefix = relative(repoRoot, dirname(resolve(options.callLogPath)));
  if (options.requireCleanWorktree !== false) {
    assertCleanWorktree(
      repoRoot,
      outputPrefix.startsWith('..') || outputPrefix === '' ? undefined : outputPrefix,
    );
  }
  const harnessCommit = git(repoRoot, ['rev-parse', 'HEAD']);

  // The key is resolved before the corpus is read, so an absent key refuses in milliseconds and
  // never looks like a corpus problem. An injected client is the offline fixture path only; it
  // is the one route that does not resolve a key, because it makes no request.
  const client =
    options.client ??
    new JevClient({
      apiKey: resolveApiKey(env),
      baseUrl: env[JEV_BASE_URL_ENV],
      logPath: options.callLogPath,
      now,
    });

  // A missing corpus is a named refusal, not a raw ENOENT: the operator's next step is
  // `build-corpus`, and the exit code must say "refused" (3) rather than "crashed" (1).
  const paths = corpusFilePaths(repoRoot);
  if (!existsSync(paths.corpus) || !existsSync(paths.manifest)) {
    throw new Error('not_run: corpus_not_built:run build-corpus first');
  }

  const loaded = loadFrozenCorpus(repoRoot);
  const cost = assertCostWithinBudget(loaded.corpus);

  const startedAt = now().toISOString();
  const observations: JevObservation[] = [];
  const modelFieldValues: string[] = [];
  let callsMade = 0;

  for (const subject of loaded.corpus.cases) {
    for (const condition of JEV_CONDITIONS) {
      const callId = `${subject.caseId}|${condition}`;
      const result = await client.call(callId, buildJevRequest(condition, subject));
      callsMade += 1;
      modelFieldValues.push(result.response.model);

      if (result.response.model !== JEV_MODEL_ID) {
        // The first call is the canary: a mismatch aborts before a second call is made.
        throw new Error(
          `not_run: model_mismatch:expected=${JEV_MODEL_ID}:actual=${result.response.model}:after_calls=${callsMade}`,
        );
      }

      const observation = observationFor(
        subject,
        condition,
        noulProbability(result.response, 'primary'),
        condition === 'E' ? choiceLabel(result.response, 'variant', JEV_CHOICE_LABELS) : null,
      );
      observations.push(observation);
      options.onProgress?.(`${callId} noul=${observation.noul}`);
    }
  }

  return jevRunSchema.parse({
    protocolVersion: loaded.corpus.protocolVersion,
    model: JEV_MODEL_ID,
    preregistrationCommit: preregistration.commit,
    preregistrationBlob: preregistration.blob,
    harnessCommit,
    frozenSourceBlobs: resolveFrozenSourceBlobs(repoRoot, harnessCommit),
    corpusDigest: loaded.sha256,
    startedAt,
    completedAt: now().toISOString(),
    callLogPath: options.callLogPath,
    // The digest is over the log's BYTES, not its path: a path digest would be a checksum of a
    // string the caller chose, and would go on matching after the log itself was rewritten.
    callLogDigest: sha256Hex(
      existsSync(options.callLogPath) ? readFileSync(options.callLogPath, 'utf8') : '',
    ),
    costEstimate: {
      budgetTokens: cost.budget.totalTokens,
      actualTokens: cost.actual.totalTokens,
      totalUsd: cost.actual.totalUsd,
    },
    modelFieldValues,
    observations,
  });
}

/** Result directories are immutable and named by run date plus corpus digest prefix. */
export function resultDirectoryName(run: Pick<JevRun, 'startedAt' | 'corpusDigest'>): string {
  return `${run.startedAt.slice(0, 10)}-${run.corpusDigest.slice(0, 12)}`;
}
