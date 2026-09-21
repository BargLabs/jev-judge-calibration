/**
 * Post hoc secondary analysis for the Jev judge calibration experiment.
 *
 * Everything here runs AFTER the primary result was scored and published. No prediction was
 * pre-registered for any table below; nothing here is tuned to a hand-computed figure quoted
 * elsewhere — a run either reproduces the primary result from the frozen call log and the frozen
 * corpus exactly, or it refuses and writes nothing. A difference from a previously stated number
 * is a finding this module reports, never one it reconciles.
 *
 * This module owns no write path into `constants.ts`, `corpus.ts`, `metrics.ts` or `runner.ts`:
 * every one of those stays frozen, and every refusal below is a comparison against what they
 * already computed — never a change to how they compute it.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { wilsonInterval } from '../in-scope-cejel-recall-v4/report.js';
import { choiceLabel, jevResponseSchema, noulProbability } from './client.js';
import {
  JEV_BOOTSTRAP_RESAMPLES,
  JEV_CHOICE_LABELS,
  JEV_CONDITIONS,
  type JevArm,
  type JevChoiceLabel,
  type JevCondition,
  type JevVariant,
} from './constants.js';
import { type JevCorpus, loadFrozenCorpus, sha256Hex } from './corpus.js';
import {
  type JevMetrics,
  type JevObservation,
  type Rate,
  cleared,
  computeJevMetrics,
} from './metrics.js';

// ---------------------------------------------------------------------------
// Reconstruction from the call log
// ---------------------------------------------------------------------------

interface CorpusCaseInfo {
  baseCaseId: string;
  arm: JevArm;
  variant: JevVariant | null;
  oracleAccurate: 0 | 1;
}

function corpusCaseIndex(corpus: JevCorpus): Map<string, CorpusCaseInfo> {
  const index = new Map<string, CorpusCaseInfo>();
  for (const entry of corpus.cases) {
    index.set(entry.caseId, {
      baseCaseId: entry.baseCaseId,
      arm: entry.arm,
      variant: entry.variant,
      oracleAccurate: entry.oracleAccurate,
    });
  }
  return index;
}

const callLogLineSchema = z
  .object({
    at: z.string().min(1),
    callId: z.string().min(1),
    attempt: z.number().int().positive(),
    direction: z.string().min(1),
    status: z.number().int().optional(),
    body: z.unknown(),
  })
  .passthrough();

/**
 * Rebuilds the observations the primary run recorded, purely from the append-only call log and
 * the corpus it was built against — never from a live call.
 *
 * Only a `response` line at HTTP 200 counts as an answer: a retried attempt logs a failed
 * `response` line too, and the case's one accepted answer is the 200 among them. Iterating the log
 * in its own written order (rather than re-deriving order from `corpus.cases`) is not incidental:
 * `computeJevMetrics`'s cluster bootstrap draws depend on the order base cases first appear in the
 * observations array, and the log was written in exactly the call order the primary run made it in
 * — so preserving file order here is what lets the bootstrap intervals reproduce bit for bit.
 */
export function observationsFromCallLog(callLogPath: string, corpus: JevCorpus): JevObservation[] {
  const bytes = readFileSync(callLogPath, 'utf8');
  const index = corpusCaseIndex(corpus);
  const observations: JevObservation[] = [];
  const seen = new Set<string>();

  for (const rawLine of bytes.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const record = callLogLineSchema.parse(JSON.parse(line));
    if (record.direction !== 'response' || record.status !== 200) continue;
    if (seen.has(record.callId)) {
      throw new Error(`call_log_duplicate_response:${record.callId}`);
    }
    seen.add(record.callId);

    const pipeAt = record.callId.lastIndexOf('|');
    const subjectCaseId = record.callId.slice(0, pipeAt);
    const condition = record.callId.slice(pipeAt + 1);
    if (pipeAt < 0 || !JEV_CONDITIONS.includes(condition as JevCondition)) {
      throw new Error(`call_log_unrecognised_call_id:${record.callId}`);
    }

    const info = index.get(subjectCaseId);
    if (!info) throw new Error(`call_log_case_not_in_corpus:${subjectCaseId}`);

    const responseText =
      typeof record.body === 'string' ? record.body : JSON.stringify(record.body);
    const response = jevResponseSchema.parse(JSON.parse(responseText));

    const noul = noulProbability(response, 'primary');
    const choice = condition === 'E' ? choiceLabel(response, 'variant', JEV_CHOICE_LABELS) : null;

    observations.push({
      caseId: record.callId,
      baseCaseId: info.baseCaseId,
      condition: condition as JevCondition,
      arm: info.arm,
      variant: info.variant,
      oracleAccurate: info.oracleAccurate,
      noul,
      choice,
    });
  }

  return observations;
}

// ---------------------------------------------------------------------------
// Reproduction gate
// ---------------------------------------------------------------------------

/**
 * Comparing through one JSON round trip on both sides means `NaN` (an unrepresentable JSON value,
 * serialised as `null`) compares equal to itself on both the freshly computed and the
 * previously-published side, without a special case: both go through the same lossy conversion.
 */
function metricsFieldDiffers(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

export function firstDivergentMetricsField(
  computed: JevMetrics,
  primary: JevMetrics,
): string | null {
  for (const key of Object.keys(computed) as (keyof JevMetrics)[]) {
    if (metricsFieldDiffers(computed[key], primary[key])) return key;
  }
  for (const key of Object.keys(primary) as (keyof JevMetrics)[]) {
    if (!(key in computed)) return key;
  }
  return null;
}

/**
 * The secondary is published only from a call log that reproduces the primary result exactly.
 * Bootstrap intervals are included in the comparison, not exempted: given the same observation
 * order and the same resample count, the fixed-seed PRNG this repeats an identical draw sequence,
 * so a genuine reproduction is bit-exact on those fields too.
 */
export function reproducePrimaryMetricsOrRefuse(
  observations: readonly JevObservation[],
  primaryMetrics: JevMetrics,
  resamples: number = JEV_BOOTSTRAP_RESAMPLES,
): JevMetrics {
  const metrics = computeJevMetrics(observations, resamples);
  const divergentField = firstDivergentMetricsField(metrics, primaryMetrics);
  if (divergentField) {
    throw new Error(`not_run: primary_metrics_not_reproduced:${divergentField}`);
  }
  return metrics;
}

// ---------------------------------------------------------------------------
// Label space and constant-answer baseline
// ---------------------------------------------------------------------------

export interface LabelSpaceEntry {
  label: JevChoiceLabel;
  n: number;
}

export interface ChoiceLabelSpace {
  n: number;
  labels: LabelSpaceEntry[];
  largestClass: LabelSpaceEntry;
  baseline: Rate;
}

function truthLabel(observation: Pick<JevObservation, 'variant'>): JevChoiceLabel {
  return observation.variant ?? 'accurate';
}

function choiceScopedObservations(observations: readonly JevObservation[]): JevObservation[] {
  return observations.filter((entry) => entry.condition === 'E' && entry.choice !== null);
}

/**
 * The five-label truth distribution behind the Choice question, and the baseline a constant
 * answer of the single largest label would score — the number a binary (accurate / not-accurate)
 * split of the same population would NOT produce, because the largest of five classes is smaller
 * than the largest of two.
 */
export function choiceLabelSpace(observations: readonly JevObservation[]): ChoiceLabelSpace {
  const scoped = choiceScopedObservations(observations);
  const counts = new Map<JevChoiceLabel, number>(JEV_CHOICE_LABELS.map((label) => [label, 0]));
  for (const entry of scoped) {
    const label = truthLabel(entry);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const labels = JEV_CHOICE_LABELS.map((label) => ({ label, n: counts.get(label) ?? 0 }));
  const largestClass = labels.reduce((max, entry) => (entry.n > max.n ? entry : max));
  const n = scoped.length;
  return {
    n,
    labels,
    largestClass,
    baseline:
      n === 0
        ? { numerator: 0, denominator: 0, rate: Number.NaN, interval: wilsonInterval(0, 1) }
        : {
            numerator: largestClass.n,
            denominator: n,
            rate: largestClass.n / n,
            interval: wilsonInterval(largestClass.n, n),
          },
  };
}

// ---------------------------------------------------------------------------
// Per-label Choice accuracy and confusion matrix
// ---------------------------------------------------------------------------

export interface PerLabelAccuracyRow {
  truth: JevChoiceLabel;
  arm: JevArm | 'pooled';
  numerator: number;
  denominator: number;
  rate: number | null;
}

export interface ConfusionCell {
  truth: JevChoiceLabel;
  pick: JevChoiceLabel;
  n: number;
}

export interface PerLabelAccuracy {
  rows: PerLabelAccuracyRow[];
  confusion: ConfusionCell[];
}

/** Correct/n per truth label, per arm and pooled, plus the full truth-by-pick confusion matrix. */
export function perLabelChoiceAccuracy(observations: readonly JevObservation[]): PerLabelAccuracy {
  const scoped = choiceScopedObservations(observations);
  const rows: PerLabelAccuracyRow[] = [];

  for (const truth of JEV_CHOICE_LABELS) {
    const truthCases = scoped.filter((entry) => truthLabel(entry) === truth);
    const arms = [...new Set(truthCases.map((entry) => entry.arm))];
    for (const arm of arms) {
      const cell = truthCases.filter((entry) => entry.arm === arm);
      const numerator = cell.filter((entry) => entry.choice === truth).length;
      rows.push({
        truth,
        arm,
        numerator,
        denominator: cell.length,
        rate: cell.length === 0 ? null : numerator / cell.length,
      });
    }
    const numerator = truthCases.filter((entry) => entry.choice === truth).length;
    rows.push({
      truth,
      arm: 'pooled',
      numerator,
      denominator: truthCases.length,
      rate: truthCases.length === 0 ? null : numerator / truthCases.length,
    });
  }

  const confusion: ConfusionCell[] = [];
  for (const truth of JEV_CHOICE_LABELS) {
    for (const pick of JEV_CHOICE_LABELS) {
      const n = scoped.filter(
        (entry) => truthLabel(entry) === truth && entry.choice === pick,
      ).length;
      confusion.push({ truth, pick, n });
    }
  }

  return { rows, confusion };
}

// ---------------------------------------------------------------------------
// Choice-by-Noul cross-tabulation
// ---------------------------------------------------------------------------

export interface ChoiceByNoulCell {
  choiceCorrect: boolean;
  cleared: boolean;
  n: number;
}

export interface ChoiceByNoulCrossTab {
  n: number;
  cells: ChoiceByNoulCell[];
  /** right+cleared / (right+cleared + right+flagged); `null` when no case had a correct choice. */
  clearedShareOfCorrect: number | null;
}

/**
 * Cross-tabs the Choice answer's correctness against the separate Noul question's clearance, on
 * defective cases in condition E only. The two questions can disagree: a report can be correctly
 * labelled by name and still be cleared by the primary probability question on the same call.
 */
export function choiceByNoulCrossTab(
  observations: readonly JevObservation[],
): ChoiceByNoulCrossTab {
  const defective = observations.filter(
    (entry) => entry.condition === 'E' && entry.arm !== 'clean' && entry.choice !== null,
  );
  const cells: ChoiceByNoulCell[] = [];
  let rightCleared = 0;
  let rightFlagged = 0;
  for (const choiceCorrect of [true, false]) {
    for (const isCleared of [true, false]) {
      const n = defective.filter(
        (entry) =>
          (entry.choice === entry.variant) === choiceCorrect && cleared(entry) === isCleared,
      ).length;
      cells.push({ choiceCorrect, cleared: isCleared, n });
      if (choiceCorrect && isCleared) rightCleared = n;
      if (choiceCorrect && !isCleared) rightFlagged = n;
    }
  }
  const rightTotal = rightCleared + rightFlagged;
  return {
    n: defective.length,
    cells,
    clearedShareOfCorrect: rightTotal === 0 ? null : rightCleared / rightTotal,
  };
}

// ---------------------------------------------------------------------------
// Table bundle
// ---------------------------------------------------------------------------

export interface SecondaryTables {
  labelSpace: ChoiceLabelSpace;
  perLabelAccuracy: PerLabelAccuracyRow[];
  confusionMatrix: ConfusionCell[];
  crossTab: ChoiceByNoulCrossTab;
}

export function computeSecondaryTables(observations: readonly JevObservation[]): SecondaryTables {
  const { rows, confusion } = perLabelChoiceAccuracy(observations);
  return {
    labelSpace: choiceLabelSpace(observations),
    perLabelAccuracy: rows,
    confusionMatrix: confusion,
    crossTab: choiceByNoulCrossTab(observations),
  };
}

// ---------------------------------------------------------------------------
// The committed primary result
// ---------------------------------------------------------------------------

const primaryMetricsSchema = z
  .object({
    falseClear: z.array(z.unknown()),
    falseFlag: z.array(z.unknown()),
    adversarialShift: z.array(z.unknown()),
    calibration: z.array(z.unknown()),
    choiceAccuracy: z.array(z.unknown()),
    observations: z.number().int().nonnegative(),
    baseCases: z.number().int().nonnegative(),
  })
  .passthrough();

const primaryResultFileSchema = z
  .object({
    model: z.string().min(1),
    harnessCommit: z.string().min(1),
    corpusDigest: z.string().regex(/^[0-9a-f]{64}$/),
    callLogDigest: z.string().regex(/^[0-9a-f]{64}$/),
    startedAt: z.string().min(1),
    completedAt: z.string().min(1),
    metrics: primaryMetricsSchema,
  })
  .passthrough();
export type PrimaryResultFile = z.infer<typeof primaryResultFileSchema>;

/** Locates the one committed `jev-judge-calibration-result-*.json` beside which the secondary
 * belongs. Zero or more than one is a refusal: the secondary must bind to exactly one primary. */
export function findPrimaryResultFile(primaryResultDir: string): string {
  const candidates = readdirSync(primaryResultDir).filter((name) =>
    /^jev-judge-calibration-result-.*\.json$/.test(name),
  );
  const [first, ...rest] = candidates;
  if (!first) {
    throw new Error(`not_run: primary_result_not_found:${primaryResultDir}`);
  }
  if (rest.length > 0) {
    throw new Error(`not_run: primary_result_ambiguous:${candidates.join(',')}`);
  }
  return join(primaryResultDir, first);
}

export function loadPrimaryResult(primaryResultDir: string): PrimaryResultFile {
  const path = findPrimaryResultFile(primaryResultDir);
  return primaryResultFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface SecondaryRunOptions {
  repoRoot: string;
  /** `undefined` refuses: `JEV_CALL_LOG` names the operator-held path, and the operator's absence
   * of it is not a default. */
  callLogPath: string | undefined;
  primaryResultDir: string;
}

export interface SecondaryRun {
  callLogPath: string;
  callLogDigest: string;
  corpusDigest: string;
  primary: PrimaryResultFile;
  observations: JevObservation[];
  reproducedMetrics: JevMetrics;
  tables: SecondaryTables;
}

export function runSecondaryFromCallLog(options: SecondaryRunOptions): SecondaryRun {
  const callLogPath = options.callLogPath;
  if (!callLogPath || !existsSync(callLogPath)) {
    throw new Error('not_run: call_log_absent');
  }

  const primary = loadPrimaryResult(options.primaryResultDir);

  const callLogBytes = readFileSync(callLogPath, 'utf8');
  const callLogDigest = sha256Hex(callLogBytes);
  if (callLogDigest !== primary.callLogDigest) {
    throw new Error('not_run: call_log_digest_mismatch');
  }

  const loadedCorpus = loadFrozenCorpus(options.repoRoot);
  if (loadedCorpus.sha256 !== primary.corpusDigest) {
    throw new Error('not_run: corpus_digest_mismatch');
  }

  const observations = observationsFromCallLog(callLogPath, loadedCorpus.corpus);
  const reproducedMetrics = reproducePrimaryMetricsOrRefuse(
    observations,
    primary.metrics as unknown as JevMetrics,
  );

  return {
    callLogPath,
    callLogDigest,
    corpusDigest: loadedCorpus.sha256,
    primary,
    observations,
    reproducedMetrics,
    tables: computeSecondaryTables(observations),
  };
}

// ---------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------

export interface PublishedSecondaryResult {
  json: string;
  markdown: string;
}

function pct(value: number | null): string {
  return value === null || !Number.isFinite(value) ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

export function publishSecondaryResult(
  run: SecondaryRun,
  limitsParagraph: string,
): PublishedSecondaryResult {
  const { labelSpace, perLabelAccuracy, confusionMatrix, crossTab } = run.tables;
  const choiceAccuracyE = (
    run.reproducedMetrics.choiceAccuracy as { condition: string; numerator: number }[]
  ).find((entry) => entry.condition === 'E');

  const json = `${JSON.stringify(
    {
      kind: 'post_hoc_secondary_analysis',
      computedFrom: 'frozen_call_log_after_scored_primary_analysis',
      predictionRegistered: false,
      primaryReproducedExactly: true,
      callLogDigest: run.callLogDigest,
      corpusDigest: run.corpusDigest,
      primaryHarnessCommit: run.primary.harnessCommit,
      primaryModel: run.primary.model,
      primaryRunWindow: { startedAt: run.primary.startedAt, completedAt: run.primary.completedAt },
      labelSpace,
      perLabelAccuracy,
      confusionMatrix,
      crossTab,
    },
    null,
    2,
  )}\n`;

  const labelRows = labelSpace.labels.map((entry) => `| ${entry.label} | ${entry.n} |`).join('\n');

  const accuracyRows = perLabelAccuracy
    .map(
      (row) =>
        `| ${row.truth} | ${row.arm} | ${row.numerator} | ${row.denominator} | ${row.rate === null ? 'n/a' : pct(row.rate)} |`,
    )
    .join('\n');

  const confusionHeader = `| Truth \\ Pick | ${JEV_CHOICE_LABELS.join(' | ')} |`;
  const confusionDivider = `|---|${JEV_CHOICE_LABELS.map(() => '---').join('|')}|`;
  const confusionRows = JEV_CHOICE_LABELS.map((truth) => {
    const cells = JEV_CHOICE_LABELS.map((pick) => {
      const cell = confusionMatrix.find((entry) => entry.truth === truth && entry.pick === pick);
      return cell ? cell.n : 0;
    });
    return `| ${truth} | ${cells.join(' | ')} |`;
  }).join('\n');

  const crossTabRows = crossTab.cells
    .map(
      (cell) =>
        `| ${cell.choiceCorrect ? 'right' : 'wrong'} | ${cell.cleared ? 'cleared' : 'flagged'} | ${cell.n} |`,
    )
    .join('\n');

  const markdown = `# Jev 1.13 as a judge of agent completion reports — secondary analysis

${limitsParagraph}

This is a post hoc secondary analysis, computed from the frozen call log after the primary
analysis was scored and published. No prediction was registered for any table below. The
primary result's metrics were reproduced exactly from this call log and the frozen corpus before
any table here was computed — a run that does not reproduce writes nothing.

Call log digest: \`${run.callLogDigest}\`
Corpus digest: \`${run.corpusDigest}\`
Primary harness commit: \`${run.primary.harnessCommit}\`
Primary run window: ${run.primary.startedAt} to ${run.primary.completedAt}

## Label space and constant-answer baseline (condition E)

Choice accuracy in E (reproduced exactly from the primary): ${choiceAccuracyE?.numerator ?? 'n/a'} / ${labelSpace.n}

| Truth label | n |
|---|---|
${labelRows}

Largest class: \`${labelSpace.largestClass.label}\` (n=${labelSpace.largestClass.n})
Constant-answer baseline: ${labelSpace.baseline.numerator}/${labelSpace.baseline.denominator} = ${pct(labelSpace.baseline.rate)} [${pct(labelSpace.baseline.interval.lower)}, ${pct(labelSpace.baseline.interval.upper)}]

A binary split of this population (accurate vs. not) would report a different, higher baseline;
the figure above is the constant-answer baseline over the actual five-label space the Choice
question offers, and is the one this rate should be read against.

## Per-label Choice accuracy (condition E)

| Truth label | Arm | Correct | n | Rate |
|---|---|---|---|---|
${accuracyRows}

## Confusion matrix — truth by pick (condition E)

${confusionHeader}
${confusionDivider}
${confusionRows}

## Choice-by-Noul cross-tabulation on defective cases (condition E)

| Choice | Noul | n |
|---|---|---|
${crossTabRows}

Share of correctly-labelled defects that were cleared by the separate Noul question (noul ≥ 0.5):
${crossTab.clearedShareOfCorrect === null ? 'n/a' : pct(crossTab.clearedShareOfCorrect)}
`;

  return { json, markdown };
}
