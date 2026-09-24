/**
 * Arm B — the live composed run.
 *
 * One call per condition-`E` case, one prompt whose questions are asked in Choice-then-Noul order:
 * the Choice question and criteria unchanged from `JEV_CHOICE_INSTRUCTIONS` /
 * `JEV_CHOICE_CRITERIA`, followed by one Noul asking for the probability that the label just given
 * is `accurate`. This module never calls the API itself when dispatched as an agent:
 * `runComposedArmB` resolves `TYPESAFE_API_KEY` at call time exactly as `runJevExperiment` does,
 * and an absent key is `not_run: missing_api_key`, never a default. The run is the operator's; the
 * agent verifies the request shape and the observation pipeline against a recorded-response
 * fixture only.
 *
 * This module owns no write path into `constants.ts`, `corpus.ts`, `metrics.ts` or `runner.ts`, and
 * reuses each of them by import rather than by edit — `runner.ts`'s own pre-registration-ancestor
 * guard is hardcoded to `JEV_PREREGISTRATION_PATH` (the 2026-09-19 document), so this module writes
 * its own guard against this experiment's later, separate pre-registration rather than editing the
 * frozen one.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import { JevClient, type JevRequest, choiceLabel, noulProbability } from './client.js';
import {
  JEV_COMPOSITION_EXPECTED_CORPUS_DIGEST,
  JEV_COMPOSITION_NOUL_QUESTION,
  JEV_COMPOSITION_PREREGISTRATION_PATH,
  composedFalseClearTable,
  scoreP2cB,
  scoreP2cC,
} from './composition.js';
import {
  JEV_BASE_URL_ENV,
  JEV_CHOICE_INSTRUCTIONS,
  JEV_CHOICE_LABELS,
  JEV_MODEL_ID,
  JEV_PRICE_PER_MILLION_INPUT_TOKENS,
  JEV_TOKEN_BUDGET_BY_CONDITION,
} from './constants.js';
import {
  type JevCase,
  choiceCriteria,
  loadFrozenCorpus,
  renderState,
  sha256Hex,
} from './corpus.js';
import { type JevObservation, computeJevMetrics } from './metrics.js';
import { type ScoredPrediction, pct } from './publish.js';
import {
  assertCleanWorktree,
  estimateTokens,
  resolveApiKey,
  resolveJevRepoRoot,
} from './runner.js';
import { computeSecondaryTables } from './secondary.js';

// ---------------------------------------------------------------------------
// Composition pre-registration freeze guard
// ---------------------------------------------------------------------------

function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

export interface CompositionPreregistrationBinding {
  commit: string;
  blob: string;
  path: string;
}

/**
 * Mirrors `assertPreregistrationFrozen` in `runner.ts` field for field, but resolved against
 * `JEV_COMPOSITION_PREREGISTRATION_PATH` — this experiment's own pre-registration — rather than
 * the 2026-09-19 document `runner.ts` is hardcoded to. `runner.ts` is frozen, so this cannot be a
 * parameter added to the existing function; it is a new, small guard with the same two-part shape:
 * the first-add commit is a strict ancestor of `HEAD`, and the file's current bytes still hash to
 * its blob at that commit.
 */
export function assertCompositionPreregistrationFrozen(
  repoRoot: string,
): CompositionPreregistrationBinding {
  const path = JEV_COMPOSITION_PREREGISTRATION_PATH;
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
    throw new Error('not_run: composition_preregistration_not_ancestor:never_committed');
  }

  const head = git(repoRoot, ['rev-parse', 'HEAD']);
  const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', firstCommit, head], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (ancestry.status !== 0 || firstCommit === head) {
    throw new Error(`not_run: composition_preregistration_not_ancestor:${firstCommit}:${head}`);
  }

  const frozenBlob = git(repoRoot, ['rev-parse', `${firstCommit}:${path}`]);
  const workingBlob = git(repoRoot, ['hash-object', path]);
  if (frozenBlob !== workingBlob) {
    throw new Error(
      `not_run: composition_preregistration_modified_after_freeze:frozen=${frozenBlob}:working=${workingBlob}`,
    );
  }

  return { commit: firstCommit, blob: frozenBlob, path };
}

// ---------------------------------------------------------------------------
// Request — Choice before Noul, frozen wording
// ---------------------------------------------------------------------------

/**
 * The Choice question is asked first (`variant`), the composed-probability Noul second
 * (`primary`) — the reverse of `buildJevRequest` in `runner.ts`, and the whole point of Arm B.
 * `buildJevRequestBody` (`client.ts`) serialises `questions` in insertion order, so the object
 * literal's key order below is the wire order a golden-request test can pin.
 */
export function buildComposedJevRequest(subject: JevCase): JevRequest {
  return {
    state: renderState('E', subject),
    questions: {
      variant: {
        type: 'choice',
        instructions: JEV_CHOICE_INSTRUCTIONS,
        criteria: choiceCriteria(),
      },
      primary: {
        type: 'noul',
        instructions: JEV_COMPOSITION_NOUL_QUESTION,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface ComposedArmBRun {
  protocolVersion: string;
  model: string;
  compositionPreregistrationCommit: string;
  compositionPreregistrationBlob: string;
  harnessCommit: string;
  corpusDigest: string;
  startedAt: string;
  completedAt: string;
  callLogPath: string;
  callLogDigest: string;
  costEstimate: { budgetTokens: number; actualTokens: number; totalUsd: number };
  modelFieldValues: string[];
  observations: JevObservation[];
}

export interface RunComposedArmBOptions {
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  /** Offline fixture path only. Production leaves this unset and a real client is constructed. */
  client?: Pick<JevClient, 'call'>;
  callLogPath: string;
  now?: () => Date;
  onProgress?: (message: string) => void;
  /** Escape hatch for the offline fixture test only; production passes nothing. */
  requireCleanWorktree?: boolean;
  /** Escape hatch for the offline fixture test only, which builds a small synthetic corpus with
   * its own digest; production never sets this and gets the pinned
   * `JEV_COMPOSITION_EXPECTED_CORPUS_DIGEST`. */
  expectedCorpusDigest?: string;
}

export async function runComposedArmB(options: RunComposedArmBOptions): Promise<ComposedArmBRun> {
  const repoRoot = resolveJevRepoRoot(options.repoRoot);
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());

  const preregistration = assertCompositionPreregistrationFrozen(repoRoot);
  const outputPrefix = relative(repoRoot, dirname(resolve(options.callLogPath)));
  if (options.requireCleanWorktree !== false) {
    assertCleanWorktree(
      repoRoot,
      outputPrefix.startsWith('..') || outputPrefix === '' ? undefined : outputPrefix,
    );
  }
  const harnessCommit = git(repoRoot, ['rev-parse', 'HEAD']);

  const client =
    options.client ??
    new JevClient({
      apiKey: resolveApiKey(env),
      baseUrl: env[JEV_BASE_URL_ENV],
      logPath: options.callLogPath,
      now,
    });

  const loaded = loadFrozenCorpus(repoRoot);
  const expectedCorpusDigest =
    options.expectedCorpusDigest ?? JEV_COMPOSITION_EXPECTED_CORPUS_DIGEST;
  if (loaded.sha256 !== expectedCorpusDigest) {
    throw new Error(
      `not_run: composition_corpus_digest_mismatch:expected=${expectedCorpusDigest}:actual=${loaded.sha256}`,
    );
  }

  const startedAt = now().toISOString();
  const observations: JevObservation[] = [];
  const modelFieldValues: string[] = [];
  let callsMade = 0;
  let estimatedTokens = 0;

  for (const subject of loaded.corpus.cases) {
    const callId = `${subject.caseId}|E-composed`;
    const request = buildComposedJevRequest(subject);
    estimatedTokens += estimateTokens(request.state);

    const result = await client.call(callId, request);
    callsMade += 1;
    modelFieldValues.push(result.response.model);

    if (result.response.model !== JEV_MODEL_ID) {
      throw new Error(
        `not_run: model_mismatch:expected=${JEV_MODEL_ID}:actual=${result.response.model}:after_calls=${callsMade}`,
      );
    }

    observations.push({
      caseId: callId,
      baseCaseId: subject.baseCaseId,
      condition: 'E',
      arm: subject.arm,
      variant: subject.variant,
      oracleAccurate: subject.oracleAccurate,
      noul: noulProbability(result.response, 'primary'),
      choice: choiceLabel(result.response, 'variant', JEV_CHOICE_LABELS),
    });
    options.onProgress?.(
      `${callId} noul=${observations[observations.length - 1]?.noul} choice=${observations[observations.length - 1]?.choice}`,
    );
  }

  const completedAt = now().toISOString();
  const callLogDigest = sha256Hex(
    existsSync(options.callLogPath) ? readFileSync(options.callLogPath, 'utf8') : '',
  );
  const budgetTokens = loaded.corpus.cases.length * JEV_TOKEN_BUDGET_BY_CONDITION.E;
  const totalUsd = (estimatedTokens * JEV_PRICE_PER_MILLION_INPUT_TOKENS) / 1_000_000;

  return {
    protocolVersion: loaded.corpus.protocolVersion,
    model: JEV_MODEL_ID,
    compositionPreregistrationCommit: preregistration.commit,
    compositionPreregistrationBlob: preregistration.blob,
    harnessCommit,
    corpusDigest: loaded.sha256,
    startedAt,
    completedAt,
    callLogPath: options.callLogPath,
    callLogDigest,
    costEstimate: { budgetTokens, actualTokens: estimatedTokens, totalUsd },
    modelFieldValues,
    observations,
  };
}

// ---------------------------------------------------------------------------
// Publication — Arm B
// ---------------------------------------------------------------------------

export interface PublishedComposedArmBResult {
  json: string;
  markdown: string;
  predictions: ScoredPrediction[];
}

export function publishComposedArmBResult(
  run: ComposedArmBRun,
  limitsParagraph: string,
): PublishedComposedArmBResult {
  const metrics = computeJevMetrics(run.observations);
  const tables = computeSecondaryTables(run.observations);
  const calibrationE = metrics.calibration.find((entry) => entry.condition === 'E');
  const choiceAccuracyE = metrics.choiceAccuracy.find((entry) => entry.condition === 'E');
  if (!calibrationE) throw new Error('composed_arm_b_missing_calibration_E');

  const falseClear = composedFalseClearTable(run.observations);
  const predictions = [scoreP2cB(falseClear), scoreP2cC(choiceAccuracyE?.rate ?? null)];

  const json = `${JSON.stringify(
    {
      kind: 'live_composed_run',
      protocolVersion: run.protocolVersion,
      model: run.model,
      compositionPreregistrationCommit: run.compositionPreregistrationCommit,
      compositionPreregistrationBlob: run.compositionPreregistrationBlob,
      harnessCommit: run.harnessCommit,
      corpusDigest: run.corpusDigest,
      callLogDigest: run.callLogDigest,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      costEstimate: run.costEstimate,
      falseClear,
      calibration: calibrationE,
      choiceAccuracy: choiceAccuracyE ?? null,
      labelSpace: tables.labelSpace,
      crossTab: tables.crossTab,
      predictions,
    },
    null,
    2,
  )}\n`;

  const falseClearRows = falseClear
    .map(
      (row) =>
        `| ${row.variant} | ${row.arm} | ${row.numerator} | ${row.denominator} | ${row.claimBearing ? `${pct(row.rate)} [${pct(row.interval.lower)}, ${pct(row.interval.upper)}]` : 'WITHHELD'} | ${row.refusalReasons.join('; ') || '—'} |`,
    )
    .join('\n');

  const predictionRows = predictions
    .map(
      (prediction) =>
        `| ${prediction.id} | ${prediction.verdict} | ${prediction.measured} |\n| | | _${prediction.note}_ |`,
    )
    .join('\n');

  const markdown = `# Jev 1.13 composed clearing — Arm B (live, Choice before Noul)

${limitsParagraph}

Live run. The prompt asked the Choice question first, then the Noul question worded to be the
probability that the label just given is \`accurate\`
(\`docs/experiments/jev-judge-composition-preregistration-2026-09-22.md\`). One call per
condition-\`E\` case; no condition-\`T\` calls are made by this arm.

Composition pre-registration commit: \`${run.compositionPreregistrationCommit}\` (blob \`${run.compositionPreregistrationBlob}\`)
Harness commit: \`${run.harnessCommit}\`
Corpus digest: \`${run.corpusDigest}\`
Call log digest: \`${run.callLogDigest}\`
Run window: ${run.startedAt} to ${run.completedAt}
Observed input tokens (estimated): ${run.costEstimate.actualTokens}; cost US$${run.costEstimate.totalUsd.toFixed(4)}
Observations: ${run.observations.length}

Every response's \`model\` field was checked against \`${run.model}\` before its answer was recorded.

## Scored predictions

| Prediction | Verdict | Measured |
|---|---|---|
${predictionRows}

## False-clear rate — P(noul ≥ 0.5 | defective), the live composed Noul

| Variant | Arm | Cleared | n | Rate [95% Wilson] | Refusal |
|---|---|---|---|---|---|
${falseClearRows}

## Calibration against outcomes — condition E

- n = ${calibrationE.n}
- ECE = ${calibrationE.ece.toFixed(3)} ${calibrationE.eceInterval ? `[${calibrationE.eceInterval.lower.toFixed(3)}, ${calibrationE.eceInterval.upper.toFixed(3)}]` : '[interval unavailable]'}
- Brier = ${calibrationE.brier.toFixed(3)}
- Verdict: **${calibrationE.verdict}**${calibrationE.gateFailures.length > 0 ? ` (gate failures: ${calibrationE.gateFailures.join('; ')})` : ''}

## Choice accuracy, with the constant-answer baseline beside it

Choice accuracy: ${choiceAccuracyE ? `${choiceAccuracyE.numerator}/${choiceAccuracyE.denominator} = ${pct(choiceAccuracyE.rate ?? Number.NaN)}` : 'n/a'}
Constant-answer baseline (five-label space): ${tables.labelSpace.baseline.numerator}/${tables.labelSpace.baseline.denominator} = ${pct(tables.labelSpace.baseline.rate)}

## Choice-by-Noul cross-tabulation on defective cases

| Choice | Noul | n |
|---|---|---|
${tables.crossTab.cells.map((cell) => `| ${cell.choiceCorrect ? 'right' : 'wrong'} | ${cell.cleared ? 'cleared' : 'flagged'} | ${cell.n} |`).join('\n')}

Share of correctly-labelled defects cleared by the forced-order Noul (noul ≥ 0.5):
${tables.crossTab.clearedShareOfCorrect === null ? 'n/a' : pct(tables.crossTab.clearedShareOfCorrect)}
`;

  return { json, markdown, predictions };
}
