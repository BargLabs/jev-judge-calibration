/**
 * Composed-clearing secondary analysis for the Jev judge calibration experiment ("Arm A").
 *
 * The 2026-09-20 secondary showed that in 174 of 380 defective condition-`E` calls, the Choice
 * answer named the defect correctly and the separate Noul answer cleared the report in the same
 * call: the model spends the Choice on the defect and the Noul on the story. Arm A asks whether a
 * clearing score *composed from the Choice answer's own probability distribution* — rather than the
 * independently-asked Noul — would have caught what the Noul missed. It costs nothing: every Choice
 * answer already carries a `probabilities` map over the five labels, so this is a re-scoring of the
 * frozen call log under a stated rule, never a new call.
 *
 * This module owns no write path into `constants.ts`, `corpus.ts`, `metrics.ts` or `runner.ts`:
 * every one of those stays frozen. It reads through `secondary.ts`'s call-log reader and
 * reproduction gate rather than re-parsing the log or re-deriving the gate.
 *
 * Everything here is scored on condition `E` only: the Choice question, and therefore the
 * `probabilities` a composed score reads, is asked only in `E`.
 */

import { type WilsonInterval, wilsonInterval } from '../in-scope-cejel-recall-v4/report.js';
import type { JevResponse } from './client.js';
import { JEV_VARIANTS, type JevArm, type JevVariant } from './constants.js';
import { loadFrozenCorpus } from './corpus.js';
import {
  type Calibration,
  type JevObservation,
  brierScore,
  calibrationTable,
  cleared,
} from './metrics.js';
import {
  type PredictionVerdict,
  type ScoredPrediction,
  atMost,
  combine,
  num,
  pct,
} from './publish.js';
import {
  type ChoiceByNoulCrossTab,
  type PrimaryResultFile,
  type SecondaryRunOptions,
  choiceByNoulCrossTab,
  responseRecordsFromCallLog,
  runSecondaryFromCallLog,
} from './secondary.js';

// ---------------------------------------------------------------------------
// Frozen composition-specific identifiers
// ---------------------------------------------------------------------------

/** Not in `constants.ts` on purpose: that module is frozen by the 2026-09-19 pre-registration and
 * this experiment's own pre-registration is a separate, later document. */
export const JEV_COMPOSITION_PREREGISTRATION_PATH =
  'docs/experiments/jev-judge-composition-preregistration-2026-09-22.md';

/** The Noul question's frozen wording for Arm B, asked only after the Choice. Quoted byte for byte
 * in `JEV_COMPOSITION_PREREGISTRATION_PATH`; the two must never drift apart. */
export const JEV_COMPOSITION_NOUL_QUESTION =
  'Given the label you just gave, what is the probability that the report is an accurate description of the state of the work shown in the evidence?';

/** The primary's condition-E Choice accuracy (374/430), quoted in the composition pre-registration
 * as P2c-C's comparison point. Pinned here rather than recomputed so a corpus edit that changed
 * this figure would be a mismatch the P2c-C scorer can report, not a silently moving target. */
export const JEV_COMPOSITION_PRIMARY_CHOICE_ACCURACY_E = 0.87;

/** The corpus digest the primary and secondary results were computed against
 * (`docs/experiments/jev-judge-result-2026-09-20/jev-judge-calibration-result-2026-09-20.json`).
 * Arm B refuses rather than running against a corpus that has silently drifted from the one this
 * experiment's pre-registration names. */
export const JEV_COMPOSITION_EXPECTED_CORPUS_DIGEST =
  'c8d777ef059e4f1d368df004f6e3dd2a79e2fd9161aeefec63d0f78dd0d8517d';

// ---------------------------------------------------------------------------
// Composed score extraction
// ---------------------------------------------------------------------------

/**
 * Reads `answers.variant.probabilities.accurate` — the probability the model itself assigned to
 * `accurate` while answering the Choice question — and refuses rather than defaulting when it is
 * absent. A Choice answer's `probabilities` map is only guaranteed to carry a key for the label
 * actually chosen (`assertAnswersMatchQuestions` in `client.ts`); a composed score presumes the
 * full five-label distribution the documented wire shape promises, and a response that does not
 * carry it is a finding, not a zero.
 */
export function composedAccurateProbability(response: JevResponse): number {
  const answer = response.answers.variant;
  if (!answer) throw new Error('composed_score_missing_variant_answer');
  if (answer.type !== 'choice') throw new Error('composed_score_variant_not_choice');
  const value = answer.probabilities.accurate;
  if (typeof value !== 'number') {
    throw new Error('composed_score_missing_probabilities_accurate');
  }
  return value;
}

// ---------------------------------------------------------------------------
// Composed false-clear table — per label, per arm and pooled
// ---------------------------------------------------------------------------

export interface ComposedFalseClearRow {
  variant: JevVariant;
  arm: JevArm | 'pooled';
  numerator: number;
  denominator: number;
  rate: number;
  interval: WilsonInterval;
  refusalReasons: string[];
  claimBearing: boolean;
}

/** Mirrors `cellRefusals` in `metrics.ts` (frozen; not exported), restated here rather than
 * imported so this module never depends on an edit to a frozen file. */
function composedCellRefusals(numerator: number, denominator: number, cell: string): string[] {
  if (denominator === 0) return [`cell_empty:${cell}`];
  if (numerator === 0) return [`possible_construction_leakage:${cell}`];
  if (numerator === denominator) return [`cell_rate_is_perfect:${cell}`];
  return [];
}

function composedRow(
  variant: JevVariant,
  arm: JevArm | 'pooled',
  cell: readonly JevObservation[],
): ComposedFalseClearRow {
  const numerator = cell.filter(cleared).length;
  const denominator = cell.length;
  const name = `${variant}:${arm}`;
  const refusalReasons = composedCellRefusals(numerator, denominator, name);
  return {
    variant,
    arm,
    numerator,
    denominator,
    rate: denominator === 0 ? Number.NaN : numerator / denominator,
    interval: denominator === 0 ? wilsonInterval(0, 1) : wilsonInterval(numerator, denominator),
    refusalReasons,
    claimBearing: refusalReasons.length === 0,
  };
}

/**
 * False-clear (`composedScore ≥ threshold`, via the shared `cleared()`) on defective condition-`E`
 * cases, per variant, broken out by arm and pooled across arms — the same population the
 * Choice-by-Noul cross-tab in `secondary.ts` scores, so the two tables describe the same 380
 * defective calls under two different clearing rules.
 */
export function composedFalseClearTable(
  composed: readonly JevObservation[],
): ComposedFalseClearRow[] {
  const rows: ComposedFalseClearRow[] = [];
  for (const variant of JEV_VARIANTS) {
    const byVariant = composed.filter((entry) => entry.variant === variant);
    const arms = [...new Set(byVariant.map((entry) => entry.arm))];
    for (const arm of arms) {
      rows.push(
        composedRow(
          variant,
          arm,
          byVariant.filter((entry) => entry.arm === arm),
        ),
      );
    }
    rows.push(composedRow(variant, 'pooled', byVariant));
  }
  return rows;
}

export function findComposedRow(
  rows: readonly ComposedFalseClearRow[],
  variant: JevVariant,
  arm: JevArm | 'pooled' = 'pooled',
): ComposedFalseClearRow | undefined {
  return rows.find((row) => row.variant === variant && row.arm === arm);
}

// ---------------------------------------------------------------------------
// Orchestration — Arm A, from the frozen call log
// ---------------------------------------------------------------------------

export interface ComposedRun {
  callLogDigest: string;
  corpusDigest: string;
  primary: PrimaryResultFile;
  composedObservations: JevObservation[];
  falseClear: ComposedFalseClearRow[];
  calibration: Calibration;
  crossTab: ChoiceByNoulCrossTab;
}

/**
 * `composedClearingFromCallLog` reconstructs the condition-`E` observations exactly as
 * `secondary.ts` does — through `runSecondaryFromCallLog`, which enforces the reproduction gate
 * before this function reads a single field of the log — then re-derives a clearing score for
 * each `E` call from that same call's Choice `probabilities.accurate`, and evaluates the same
 * shapes (`falseClearTable`'s per-variant rows, the calibration table, the Choice-by-Noul
 * cross-tab) against that composed score instead of the independently-asked Noul.
 *
 * The reproduction gate runs first and unconditionally: a call log that does not reproduce the
 * committed primary metrics throws before any composed table is computed.
 */
export function composedClearingFromCallLog(options: SecondaryRunOptions): ComposedRun {
  const secondary = runSecondaryFromCallLog(options);

  const loadedCorpus = loadFrozenCorpus(options.repoRoot).corpus;
  const records = responseRecordsFromCallLog(secondary.callLogPath, loadedCorpus);

  const composedScoreByCallId = new Map<string, number>();
  for (const record of records) {
    if (record.condition !== 'E') continue;
    composedScoreByCallId.set(record.callId, composedAccurateProbability(record.response));
  }

  const composedObservations: JevObservation[] = secondary.observations
    .filter((observation) => observation.condition === 'E')
    .map((observation) => {
      const composedScore = composedScoreByCallId.get(observation.caseId);
      if (composedScore === undefined) {
        throw new Error(`composed_score_missing_for_case:${observation.caseId}`);
      }
      return { ...observation, noul: composedScore };
    });

  const calibration = calibrationTable(composedObservations).find(
    (entry) => entry.condition === 'E',
  );
  if (!calibration) throw new Error('composed_calibration_missing_condition_E');
  // `calibrationTable` already computes Brier per condition; asserted equal here so a future edit
  // to this module cannot silently diverge from the table it reads.
  if (calibration.brier !== brierScore(composedObservations)) {
    throw new Error('composed_brier_disagrees_with_calibration_table');
  }

  return {
    callLogDigest: secondary.callLogDigest,
    corpusDigest: secondary.corpusDigest,
    primary: secondary.primary,
    composedObservations,
    falseClear: composedFalseClearTable(composedObservations),
    calibration,
    crossTab: choiceByNoulCrossTab(composedObservations),
  };
}

// ---------------------------------------------------------------------------
// P2c-A — scored from the composed false-clear table
// ---------------------------------------------------------------------------

function rateText(row: ComposedFalseClearRow | undefined): string {
  if (!row) return 'n/a';
  if (!row.claimBearing) return `WITHHELD (${row.numerator}/${row.denominator})`;
  return `${pct(row.rate)} [${pct(row.interval.lower)}, ${pct(row.interval.upper)}] n=${row.denominator}`;
}

export const P2C_A_STATEMENT =
  'From the frozen log, using p(accurate) from the Choice probabilities as the clearing score at ' +
  'threshold 0.5, the false-clear rate on wrong_count and on scope_mismatch is at most 20%, and on ' +
  'premature it is higher than both.';

export const P2C_B_STATEMENT =
  'In the live composed arm, the Noul false-clear rate on wrong_count and on scope_mismatch is at ' +
  'most 20%.';

/**
 * Shared by P2c-A (composed score, from the frozen log) and P2c-B (the live composed arm's own
 * Noul, asked after the Choice): an at-most-20% Wilson-interval test on `wrong_count` and
 * `scope_mismatch`, plus — for P2c-A only, since P2c-B registers no ordering clause — a
 * point-estimate ordering test against `premature`. Pooled across arms, matching the population
 * the Choice-by-Noul cross-tab in `secondary.ts` was computed over.
 */
export function scoreClearingCeiling(
  falseClear: readonly ComposedFalseClearRow[],
  options: { id: string; statement: string; note: string; scoreOrdering: boolean },
): ScoredPrediction {
  const wrongCount = findComposedRow(falseClear, 'wrong_count');
  const scopeMismatch = findComposedRow(falseClear, 'scope_mismatch');
  const premature = findComposedRow(falseClear, 'premature');
  const literalRows = [wrongCount, scopeMismatch];

  const literalVerdict: PredictionVerdict = literalRows.some(
    (row) => row === undefined || !row.claimBearing,
  )
    ? 'not_evaluable'
    : combine(literalRows.map((row) => atMost((row as ComposedFalseClearRow).interval, 0.2)));

  const orderingVerdict: PredictionVerdict = !options.scoreOrdering
    ? 'supported'
    : !premature?.claimBearing || literalRows.some((row) => !row?.claimBearing)
      ? 'not_evaluable'
      : literalRows.every((row) => premature.rate > (row as ComposedFalseClearRow).rate)
        ? 'supported'
        : 'contradicted';

  const measured = [
    `wrong_count=${rateText(wrongCount)}`,
    `scope_mismatch=${rateText(scopeMismatch)}`,
    ...(options.scoreOrdering ? [`premature=${rateText(premature)}`] : []),
  ].join('; ');

  return {
    id: options.id,
    statement: options.statement,
    verdict: combine([literalVerdict, orderingVerdict]),
    measured,
    note: options.note,
  };
}

/**
 * Scored the same way the primary's P2 was scored: an at-most-20% Wilson-interval test on the two
 * literal labels, plus a point-estimate ordering test against `premature`. Pooled across arms,
 * matching the population the Choice-by-Noul cross-tab in `secondary.ts` was computed over.
 */
export function scoreP2cA(falseClear: readonly ComposedFalseClearRow[]): ScoredPrediction {
  return scoreClearingCeiling(falseClear, {
    id: 'P2c-A',
    statement: P2C_A_STATEMENT,
    scoreOrdering: true,
    note:
      'Composed clearing score p(accurate) from the Choice answer, pooled across the plain and ' +
      'persuasive arms — the same population the Choice-by-Noul cross-tab scores. The two ' +
      'at-most clauses are scored on their 95% Wilson intervals against 0.20; the ordering clause ' +
      'compares point estimates.',
  });
}

/**
 * Arm B's own P2c-B: the live arm's forced-order Noul, not a re-derived composed score. No
 * ordering clause is registered for P2c-B — only P2c-A restates the primary's `premature`
 * ordering test.
 */
export function scoreP2cB(falseClear: readonly ComposedFalseClearRow[]): ScoredPrediction {
  return scoreClearingCeiling(falseClear, {
    id: 'P2c-B',
    statement: P2C_B_STATEMENT,
    scoreOrdering: false,
    note:
      "The live arm's own Noul, asked after the Choice, wired to the question in " +
      '`JEV_COMPOSITION_NOUL_QUESTION`. Pooled across the plain and persuasive arms. Scored on the ' +
      '95% Wilson interval against 0.20.',
  });
}

export const P2C_C_STATEMENT =
  "The Choice accuracy in Arm B is within 5 points of the primary's 87.0%; forcing the order does " +
  'not degrade the label.';

/**
 * A symmetric point-estimate comparison, not an interval test: the prediction is about closeness
 * to a fixed reference figure (the primary's already-published 374/430 condition-E accuracy), not
 * a one-sided threshold, so there is no natural interval-based verdict to compute it against.
 */
export function scoreP2cC(armBChoiceAccuracyRate: number | null): ScoredPrediction {
  const verdict: PredictionVerdict =
    armBChoiceAccuracyRate === null
      ? 'not_evaluable'
      : Math.abs(armBChoiceAccuracyRate - JEV_COMPOSITION_PRIMARY_CHOICE_ACCURACY_E) <= 0.05
        ? 'supported'
        : 'contradicted';
  return {
    id: 'P2c-C',
    statement: P2C_C_STATEMENT,
    verdict,
    measured:
      armBChoiceAccuracyRate === null
        ? 'n/a'
        : `arm_b_choice_accuracy_E=${pct(armBChoiceAccuracyRate)}; primary_choice_accuracy_E=${pct(JEV_COMPOSITION_PRIMARY_CHOICE_ACCURACY_E)}; |diff|=${pct(Math.abs(armBChoiceAccuracyRate - JEV_COMPOSITION_PRIMARY_CHOICE_ACCURACY_E))}`,
    note:
      "Point-estimate comparison against the primary's published condition-E Choice accuracy " +
      '(374/430 ≈ 87.0%), not an interval test: the prediction is about closeness to a fixed ' +
      'figure, not a one-sided threshold.',
  };
}

// ---------------------------------------------------------------------------
// Publication — Arm A
// ---------------------------------------------------------------------------

export interface PublishedComposedArmAResult {
  json: string;
  markdown: string;
  prediction: ScoredPrediction;
}

export function publishComposedArmAResult(
  run: ComposedRun,
  limitsParagraph: string,
): PublishedComposedArmAResult {
  const prediction = scoreP2cA(run.falseClear);

  const json = `${JSON.stringify(
    {
      kind: 'post_hoc_composed_clearing_re_scoring',
      computedFrom: 'frozen_call_log_after_scored_primary_and_secondary_analysis',
      predictionRegisteredBeforeComputation: 'P2c-A',
      primaryReproducedExactly: true,
      callLogDigest: run.callLogDigest,
      corpusDigest: run.corpusDigest,
      primaryHarnessCommit: run.primary.harnessCommit,
      primaryModel: run.primary.model,
      primaryRunWindow: { startedAt: run.primary.startedAt, completedAt: run.primary.completedAt },
      composedObservations: run.composedObservations.length,
      falseClear: run.falseClear,
      calibration: run.calibration,
      crossTab: run.crossTab,
      prediction,
    },
    null,
    2,
  )}\n`;

  const falseClearRows = run.falseClear
    .map(
      (row) =>
        `| ${row.variant} | ${row.arm} | ${row.numerator} | ${row.denominator} | ${row.claimBearing ? `${pct(row.rate)} [${pct(row.interval.lower)}, ${pct(row.interval.upper)}]` : 'WITHHELD'} | ${row.refusalReasons.join('; ') || '—'} |`,
    )
    .join('\n');

  const binRows = run.calibration.bins
    .map(
      (bin) =>
        `| ${bin.lower.toFixed(1)}–${bin.upper.toFixed(1)} | ${bin.n} | ${num(bin.meanForecast)} | ${num(bin.meanOutcome)} |`,
    )
    .join('\n');

  const crossTabRows = run.crossTab.cells
    .map(
      (cell) =>
        `| ${cell.choiceCorrect ? 'right' : 'wrong'} | ${cell.cleared ? 'cleared' : 'flagged'} | ${cell.n} |`,
    )
    .join('\n');

  const markdown = `# Jev 1.13 composed clearing — Arm A (post hoc re-scoring of the frozen log)

${limitsParagraph}

This is a post hoc re-scoring of the frozen call log under a stated rule: the clearing score is
\`answers.variant.probabilities.accurate\`, the Choice answer's own probability of \`accurate\`,
never a new call. Prediction P2c-A was registered in
\`docs/experiments/jev-judge-composition-preregistration-2026-09-22.md\` before this number was
computed. The primary result's metrics were reproduced exactly from this call log and the frozen
corpus before any table here was computed — a run that does not reproduce writes nothing.

Call log digest: \`${run.callLogDigest}\`
Corpus digest: \`${run.corpusDigest}\`
Primary harness commit: \`${run.primary.harnessCommit}\`
Primary run window: ${run.primary.startedAt} to ${run.primary.completedAt}
Composed observations (condition E): ${run.composedObservations.length}

## P2c-A

${P2C_A_STATEMENT}

| Prediction | Verdict | Measured |
|---|---|---|
| P2c-A | ${prediction.verdict} | ${prediction.measured} |
| | | _${prediction.note}_ |

Any number under 5% on a label the Noul cleared above 80% is checked once more against the raw
probabilities before it is believed.

## Composed false-clear rate — P(p(accurate) ≥ 0.5 | defective)

A cell with zero false clears, or a perfect one, is treated as possible construction leakage: the
counts are printed and the rate is withheld.

| Variant | Arm | Cleared | n | Rate [95% Wilson] | Refusal |
|---|---|---|---|---|---|
${falseClearRows}

## Calibration against outcomes — condition E, composed score

- n = ${run.calibration.n}
- ECE = ${num(run.calibration.ece)} ${run.calibration.eceInterval ? `[${num(run.calibration.eceInterval.lower)}, ${num(run.calibration.eceInterval.upper)}]` : '[interval unavailable]'}
- Brier = ${num(run.calibration.brier)}
- Verdict: **${run.calibration.verdict}**${run.calibration.gateFailures.length > 0 ? ` (gate failures: ${run.calibration.gateFailures.join('; ')})` : ''}

| Bin | n | Mean composed score | Observed accurate |
|---|---|---|---|
${binRows}

## Choice-by-composed cross-tabulation on defective cases (condition E)

Same shape as the Choice-by-Noul cross-tab in the secondary analysis, with the composed score in
place of the independently-asked Noul.

| Choice | Composed clearance | n |
|---|---|---|
${crossTabRows}

Share of correctly-labelled defects cleared by the composed score (p(accurate) ≥ 0.5):
${run.crossTab.clearedShareOfCorrect === null ? 'n/a' : pct(run.crossTab.clearedShareOfCorrect)}

## What this does and does not show

If this number brings the false-clear rate under the pre-registered ceiling, the fix is a wire-shape
choice — the information was already in the log — and Arm B (the live, forced-order run) exists to
confirm it. If it does not, the model's label probabilities are themselves miscalibrated on this
population, and Arm B is the real test, not a formality.
`;

  return { json, markdown, prediction };
}
