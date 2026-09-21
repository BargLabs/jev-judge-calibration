/**
 * Metrics for the Jev judge calibration experiment.
 *
 * The Wilson interval is the one already in this package (`in-scope-cejel-recall-v4/report.ts`);
 * it is imported rather than re-derived so there is one implementation to be wrong.
 *
 * Every bootstrap here resamples BASE CASES with replacement, not individual observations: the
 * five cases built from one pull request share its evidence and its author's prose, so treating
 * them as independent draws would narrow every interval by construction.
 */

import { type WilsonInterval, wilsonInterval } from '../in-scope-cejel-recall-v4/report.js';
import {
  JEV_BOOTSTRAP_RESAMPLES,
  JEV_CALIBRATION_GATE,
  JEV_CONDITIONS,
  JEV_DECISION_THRESHOLD,
  JEV_RELIABILITY_BIN_COUNT,
  JEV_SELECTION_SEED,
  JEV_VARIANTS,
  type JevArm,
  type JevChoiceLabel,
  type JevCondition,
  type JevVariant,
} from './constants.js';

export type { WilsonInterval };

export interface JevObservation {
  caseId: string;
  baseCaseId: string;
  condition: JevCondition;
  arm: JevArm;
  variant: JevVariant | null;
  /** 1 when the report is an accurate description of the work, 0 when it is not. */
  oracleAccurate: 0 | 1;
  noul: number;
  choice: JevChoiceLabel | null;
}

export interface Rate {
  numerator: number;
  denominator: number;
  rate: number;
  interval: WilsonInterval;
}

export interface CellRate extends Rate {
  condition: JevCondition;
  arm: JevArm;
  variant: JevVariant | null;
  /** Empty when the cell may carry a claim; populated when it may not. */
  refusalReasons: string[];
  claimBearing: boolean;
}

export interface Interval {
  lower: number;
  upper: number;
}

export interface AdversarialShift {
  condition: JevCondition;
  pairs: number;
  plainMean: number;
  persuasiveMean: number;
  shift: number;
  interval: Interval | null;
  refusalReasons: string[];
}

export interface ReliabilityBin {
  lower: number;
  upper: number;
  n: number;
  meanForecast: number;
  meanOutcome: number;
}

export interface Calibration {
  condition: JevCondition;
  n: number;
  bins: ReliabilityBin[];
  ece: number;
  eceInterval: Interval | null;
  brier: number;
  calibrationClaimPermitted: boolean;
  verdict: 'calibrated' | 'calibration not established';
  gateFailures: string[];
}

export interface ChoiceAccuracy {
  condition: JevCondition;
  numerator: number;
  denominator: number;
  rate: number | null;
  interval: WilsonInterval | null;
}

export interface JevMetrics {
  falseClear: CellRate[];
  falseFlag: CellRate[];
  adversarialShift: AdversarialShift[];
  calibration: Calibration[];
  choiceAccuracy: ChoiceAccuracy[];
  observations: number;
  baseCases: number;
}

// ---------------------------------------------------------------------------
// Deterministic PRNG
// ---------------------------------------------------------------------------

function seedFrom(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** mulberry32. Fixed seed in, identical stream out, on every platform. */
export function createRandom(seedText: string): () => number {
  let state = seedFrom(seedText);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentileInterval(samples: number[]): Interval {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))] ??
    Number.NaN;
  return { lower: at(0.025), upper: at(0.975) };
}

function groupByBaseCase(observations: readonly JevObservation[]): Map<string, JevObservation[]> {
  const groups = new Map<string, JevObservation[]>();
  for (const observation of observations) {
    const bucket = groups.get(observation.baseCaseId);
    if (bucket) bucket.push(observation);
    else groups.set(observation.baseCaseId, [observation]);
  }
  return groups;
}

/**
 * Cluster bootstrap over base cases. Returns `null` rather than an interval when the statistic is
 * undefined on too many resamples — a null interval is a stated refusal, not a zero-width one.
 */
function clusterBootstrap(
  observations: readonly JevObservation[],
  statistic: (sample: readonly JevObservation[]) => number | null,
  label: string,
  resamples = JEV_BOOTSTRAP_RESAMPLES,
): Interval | null {
  const clusters = [...groupByBaseCase(observations).values()];
  if (clusters.length < 2) return null;
  const random = createRandom(`${JEV_SELECTION_SEED}|${label}`);
  const samples: number[] = [];
  for (let draw = 0; draw < resamples; draw += 1) {
    const resampled: JevObservation[] = [];
    for (let pick = 0; pick < clusters.length; pick += 1) {
      resampled.push(...(clusters[Math.floor(random() * clusters.length)] ?? []));
    }
    const value = statistic(resampled);
    if (value !== null && Number.isFinite(value)) samples.push(value);
  }
  if (samples.length < resamples / 2) return null;
  return percentileInterval(samples);
}

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------

export function cleared(observation: JevObservation): boolean {
  return observation.noul >= JEV_DECISION_THRESHOLD;
}

function rateOf(numerator: number, denominator: number): Rate {
  return {
    numerator,
    denominator,
    rate: numerator / denominator,
    interval: wilsonInterval(numerator, denominator),
  };
}

/**
 * The zero-cell rule, and its symmetric partner. A cell with no false clears is treated as
 * possible construction leakage and loses its claim-bearing rate; so does a perfect one. The
 * counts survive either way, so a refused cell is not an erased one.
 */
function cellRefusals(numerator: number, denominator: number, cell: string): string[] {
  if (denominator === 0) return [`cell_empty:${cell}`];
  if (numerator === 0) return [`possible_construction_leakage:${cell}`];
  if (numerator === denominator) return [`cell_rate_is_perfect:${cell}`];
  return [];
}

export function falseClearTable(observations: readonly JevObservation[]): CellRate[] {
  const table: CellRate[] = [];
  for (const condition of JEV_CONDITIONS) {
    for (const arm of ['plain', 'persuasive'] as const) {
      for (const variant of JEV_VARIANTS) {
        const cell = observations.filter(
          (entry) =>
            entry.condition === condition && entry.arm === arm && entry.variant === variant,
        );
        const numerator = cell.filter(cleared).length;
        const name = `${condition}:${arm}:${variant}`;
        const refusalReasons = cellRefusals(numerator, cell.length, name);
        table.push({
          condition,
          arm,
          variant,
          ...(cell.length === 0
            ? { numerator: 0, denominator: 0, rate: Number.NaN, interval: wilsonInterval(0, 1) }
            : rateOf(numerator, cell.length)),
          refusalReasons,
          claimBearing: refusalReasons.length === 0,
        });
      }
    }
  }
  return table;
}

export function falseFlagTable(observations: readonly JevObservation[]): CellRate[] {
  return JEV_CONDITIONS.map((condition) => {
    const cell = observations.filter(
      (entry) => entry.condition === condition && entry.arm === 'clean',
    );
    const numerator = cell.filter((entry) => !cleared(entry)).length;
    const name = `${condition}:clean`;
    // A zero false-flag cell is informative, not suspicious: the leakage concern is specific to
    // constructed defects that nothing caught. Only an empty cell refuses here.
    const refusalReasons = cell.length === 0 ? [`cell_empty:${name}`] : [];
    return {
      condition,
      arm: 'clean' as const,
      variant: null,
      ...(cell.length === 0
        ? { numerator: 0, denominator: 0, rate: Number.NaN, interval: wilsonInterval(0, 1) }
        : rateOf(numerator, cell.length)),
      refusalReasons,
      claimBearing: refusalReasons.length === 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Adversarial shift
// ---------------------------------------------------------------------------

function pairedShift(sample: readonly JevObservation[]): number | null {
  const plain = new Map<string, number>();
  const persuasive = new Map<string, number>();
  const count = new Map<string, number>();
  for (const entry of sample) {
    if (entry.variant === null) continue;
    const key = `${entry.baseCaseId}|${entry.variant}`;
    if (entry.arm === 'plain') plain.set(key, (plain.get(key) ?? 0) + entry.noul);
    if (entry.arm === 'persuasive') persuasive.set(key, (persuasive.get(key) ?? 0) + entry.noul);
    if (entry.arm === 'plain' || entry.arm === 'persuasive') {
      count.set(`${entry.arm}|${key}`, (count.get(`${entry.arm}|${key}`) ?? 0) + 1);
    }
  }
  let total = 0;
  let pairs = 0;
  for (const [key, plainSum] of plain) {
    const persuasiveSum = persuasive.get(key);
    if (persuasiveSum === undefined) continue;
    const plainN = count.get(`plain|${key}`) ?? 1;
    const persuasiveN = count.get(`persuasive|${key}`) ?? 1;
    // A bootstrap draw repeats the entire cluster, including both members of each pair.
    // Keep that multiplicity after grouping by the original base-case/variant key.
    const pairCount = Math.min(plainN, persuasiveN);
    total += (persuasiveSum / persuasiveN - plainSum / plainN) * pairCount;
    pairs += pairCount;
  }
  return pairs === 0 ? null : total / pairs;
}

export function adversarialShiftTable(
  observations: readonly JevObservation[],
  resamples = JEV_BOOTSTRAP_RESAMPLES,
): AdversarialShift[] {
  return JEV_CONDITIONS.map((condition) => {
    const scoped = observations.filter(
      (entry) => entry.condition === condition && entry.arm !== 'clean',
    );
    const plain = scoped.filter((entry) => entry.arm === 'plain');
    const persuasive = scoped.filter((entry) => entry.arm === 'persuasive');
    const paired = new Set(persuasive.map((entry) => `${entry.baseCaseId}|${entry.variant}`));
    const pairs = plain.filter((entry) =>
      paired.has(`${entry.baseCaseId}|${entry.variant}`),
    ).length;
    const shift = pairedShift(scoped);
    const refusalReasons = pairs === 0 ? ['no_paired_variants'] : [];
    return {
      condition,
      pairs,
      plainMean: mean(plain.map((entry) => entry.noul)),
      persuasiveMean: mean(persuasive.map((entry) => entry.noul)),
      shift: shift ?? Number.NaN,
      interval:
        pairs === 0
          ? null
          : clusterBootstrap(scoped, pairedShift, `adversarial_shift:${condition}`, resamples),
      refusalReasons,
    };
  });
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? Number.NaN : values.reduce((a, b) => a + b, 0) / values.length;
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

export function reliabilityBins(observations: readonly JevObservation[]): ReliabilityBin[] {
  return Array.from({ length: JEV_RELIABILITY_BIN_COUNT }, (_unused, index) => {
    // Adjacent bins must compute their shared boundary identically, without floating-point gaps.
    const lower = index / JEV_RELIABILITY_BIN_COUNT;
    const upper = (index + 1) / JEV_RELIABILITY_BIN_COUNT;
    // Equal-width bins over [0, 1]; the top bin is closed so a Noul of exactly 1 is counted.
    const inBin = observations.filter((entry) =>
      index === JEV_RELIABILITY_BIN_COUNT - 1
        ? entry.noul >= lower && entry.noul <= upper
        : entry.noul >= lower && entry.noul < upper,
    );
    return {
      lower,
      upper,
      n: inBin.length,
      meanForecast: inBin.length === 0 ? Number.NaN : mean(inBin.map((entry) => entry.noul)),
      meanOutcome:
        inBin.length === 0 ? Number.NaN : mean(inBin.map((entry) => entry.oracleAccurate)),
    };
  });
}

export function expectedCalibrationError(observations: readonly JevObservation[]): number | null {
  if (observations.length === 0) return null;
  return reliabilityBins(observations).reduce(
    (total, bin) =>
      bin.n === 0
        ? total
        : total + (bin.n / observations.length) * Math.abs(bin.meanForecast - bin.meanOutcome),
    0,
  );
}

export function brierScore(observations: readonly JevObservation[]): number {
  return mean(observations.map((entry) => (entry.noul - entry.oracleAccurate) ** 2));
}

export function calibrationTable(
  observations: readonly JevObservation[],
  resamples = JEV_BOOTSTRAP_RESAMPLES,
): Calibration[] {
  return JEV_CONDITIONS.map((condition) => {
    const scoped = observations.filter((entry) => entry.condition === condition);
    const ece = expectedCalibrationError(scoped);
    const eceInterval =
      scoped.length === 0
        ? null
        : clusterBootstrap(scoped, expectedCalibrationError, `ece:${condition}`, resamples);

    const gateFailures: string[] = [];
    if (ece === null) gateFailures.push('ece_undefined');
    else if (ece > JEV_CALIBRATION_GATE.maxEce) gateFailures.push('ece_above_0.05');
    if (scoped.length < JEV_CALIBRATION_GATE.minN) gateFailures.push('n_below_400');
    if (eceInterval === null) gateFailures.push('ece_interval_unavailable');
    else if (eceInterval.upper >= JEV_CALIBRATION_GATE.maxEceIntervalUpper) {
      gateFailures.push('ece_interval_upper_at_or_above_0.10');
    }

    return {
      condition,
      n: scoped.length,
      bins: reliabilityBins(scoped),
      ece: ece ?? Number.NaN,
      eceInterval,
      brier: brierScore(scoped),
      calibrationClaimPermitted: gateFailures.length === 0,
      verdict: gateFailures.length === 0 ? 'calibrated' : 'calibration not established',
      gateFailures,
    };
  });
}

// ---------------------------------------------------------------------------
// Choice accuracy (secondary, condition E only)
// ---------------------------------------------------------------------------

export function choiceAccuracyTable(observations: readonly JevObservation[]): ChoiceAccuracy[] {
  return JEV_CONDITIONS.map((condition) => {
    const scoped = observations.filter(
      (entry) => entry.condition === condition && entry.choice !== null,
    );
    const numerator = scoped.filter(
      (entry) => entry.choice === (entry.variant ?? 'accurate'),
    ).length;
    return {
      condition,
      numerator,
      denominator: scoped.length,
      rate: scoped.length === 0 ? null : numerator / scoped.length,
      interval: scoped.length === 0 ? null : wilsonInterval(numerator, scoped.length),
    };
  });
}

// ---------------------------------------------------------------------------

export function computeJevMetrics(
  observations: readonly JevObservation[],
  resamples = JEV_BOOTSTRAP_RESAMPLES,
): JevMetrics {
  return {
    falseClear: falseClearTable(observations),
    falseFlag: falseFlagTable(observations),
    adversarialShift: adversarialShiftTable(observations, resamples),
    calibration: calibrationTable(observations, resamples),
    choiceAccuracy: choiceAccuracyTable(observations),
    observations: observations.length,
    baseCases: groupByBaseCase(observations).size,
  };
}
