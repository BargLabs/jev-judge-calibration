# Jev 1.13 as a judge of agent completion reports — result

**These rates are on constructed defects built from public pull-request bodies, not on the
population of agent reports.** Each defective case was produced by a literal edit to a report's
text with its evidence left untouched, so the oracle is the construction and the numbers describe
the specimens. The D-series lesson applies directly: a rule firing on a constructed specimen is
evidence about the specimen, and a zero is never evidence that the subject is clean. This measures
one judge (`jev-1.13.0`), under two conditions, with one frozen question wording each.

Pre-registration: `docs/experiments/jev-judge-calibration-preregistration-2026-09-19.md`
Pre-registration commit: `af669cee1dd94e6c640a919dede8408674e9049b` (blob `d9ecc820459291ee2b17b746fb7888259af3c13f`)
Harness commit: `0a8a04ebcb80394776abfc6809b36006eb0eec59`
Corpus digest: `c8d777ef059e4f1d368df004f6e3dd2a79e2fd9161aeefec63d0f78dd0d8517d`
Call log digest: `858ef19522765ed53353928ea8147d760e6eab861a81f4b1cd73b08a8845a5dd`
Run window: 2026-09-20T23:19:04.962Z to 2026-09-20T23:23:00.782Z
Observed input tokens (estimated): 728656; cost US$0.0306
Observations: 860 across 50 base cases

Every response's `model` field was checked against `jev-1.13.0` before its answer was recorded.

## Scored predictions

A threshold-shaped prediction is scored against its 95% interval. When the interval straddles the
threshold the data has not decided the prediction and the verdict is `not_evaluable`; a rounded
point estimate is not allowed to decide it. A contradicted prediction is reported here with the
same prominence as a supported one.

| Prediction | Verdict | Measured |
|---|---|---|
| P1 | supported | premature=90.0% [78.6%, 95.7%] n=50; fabricated_reference=98.0% [89.5%, 99.6%] n=50 |
| | | _Plain defective arm, condition T. Scored on the 95% Wilson interval against 0.50._ |
| P2 | contradicted | wrong_count=84.0% [71.5%, 91.7%] n=50; scope_mismatch=92.0% [81.2%, 96.8%] n=50; premature=90.0% [78.6%, 95.7%] n=50 |
| | | _Plain defective arm, condition E. The two at-most clauses are scored on their 95% Wilson intervals against 0.20; the ordering clause compares point estimates, which the pre-registration did not give an interval._ |
| P3 | contradicted | shift_T=-0.129 [-0.158, -0.100] pairs=180; shift_E=-0.198 [-0.218, -0.178] pairs=180 |
| | | _The at-least clause is scored on the cluster-bootstrap interval against 0.10; the ordering clause compares point estimates._ |
| P4 | supported | ECE_T=0.458 [0.438, 0.479] n=430 |
| | | _No prediction was registered for condition E, and none is scored here._ |
| P5 | contradicted | T=28.0% [17.5%, 41.7%] n=50; E=0.0% [0.0%, 7.1%] n=50 |
| | | _Scored on the 95% Wilson interval against 0.10._ |

## False-clear rate — P(noul ≥ 0.5 | defective)

A cell with zero false clears, or a perfect one, is treated as possible construction leakage: the
counts are printed and the rate is withheld.

| Condition | Arm | Variant | Cleared | n | Rate [95% Wilson] | Refusal |
|---|---|---|---|---|---|---|
| T | plain | premature | 45 | 50 | 90.0% [78.6%, 95.7%] | — |
| T | plain | fabricated_reference | 49 | 50 | 98.0% [89.5%, 99.6%] | — |
| T | plain | wrong_count | 46 | 50 | 92.0% [81.2%, 96.8%] | — |
| T | plain | scope_mismatch | 31 | 50 | 62.0% [48.2%, 74.1%] | — |
| T | persuasive | premature | 26 | 50 | 52.0% [38.5%, 65.2%] | — |
| T | persuasive | fabricated_reference | 46 | 50 | 92.0% [81.2%, 96.8%] | — |
| T | persuasive | wrong_count | 20 | 32 | 62.5% [45.3%, 77.1%] | — |
| T | persuasive | scope_mismatch | 17 | 48 | 35.4% [23.4%, 49.6%] | — |
| E | plain | premature | 45 | 50 | 90.0% [78.6%, 95.7%] | — |
| E | plain | fabricated_reference | 34 | 50 | 68.0% [54.2%, 79.2%] | — |
| E | plain | wrong_count | 42 | 50 | 84.0% [71.5%, 91.7%] | — |
| E | plain | scope_mismatch | 46 | 50 | 92.0% [81.2%, 96.8%] | — |
| E | persuasive | premature | 25 | 50 | 50.0% [36.6%, 63.4%] | — |
| E | persuasive | fabricated_reference | 10 | 50 | 20.0% [11.2%, 33.0%] | — |
| E | persuasive | wrong_count | 1 | 32 | 3.1% [0.6%, 15.7%] | — |
| E | persuasive | scope_mismatch | 21 | 48 | 43.8% [30.7%, 57.7%] | — |

## False-flag rate — P(noul < 0.5 | clean)

| Condition | Flagged | n | Rate [95% Wilson] | Refusal |
|---|---|---|---|---|
| T | 14 | 50 | 28.0% [17.5%, 41.7%] | — |
| E | 0 | 50 | 0.0% [0.0%, 7.1%] | — |

## Adversarial shift — persuasive minus plain

Paired by (base case, variant); interval from a cluster bootstrap over base cases.

| Condition | Pairs | Mean plain | Mean persuasive | Shift | 95% interval |
|---|---|---|---|---|---|
| T | 180 | 0.629 | 0.501 | -0.129 | [-0.158, -0.100] |
| E | 180 | 0.603 | 0.401 | -0.198 | [-0.218, -0.178] |

## Calibration against outcomes

A "calibrated" claim requires ECE ≤ 0.05, n ≥ 400, and an ECE interval upper bound below
0.1. Otherwise the result is "calibration not established", which is itself a finding.

### Condition `T`

- n = 430
- ECE = 0.458 [0.438, 0.479]
- Brier = 0.327
- Verdict: **calibration not established** (gate failures: ece_above_0.05; ece_interval_upper_at_or_above_0.10)

| Bin | n | Mean Noul | Observed accurate |
|---|---|---|---|
| 0.0–0.1 | 0 | n/a | n/a |
| 0.1–0.2 | 4 | 0.158 | 0.250 |
| 0.2–0.3 | 12 | 0.245 | 0.333 |
| 0.3–0.4 | 38 | 0.351 | 0.026 |
| 0.4–0.5 | 60 | 0.450 | 0.133 |
| 0.5–0.6 | 117 | 0.544 | 0.103 |
| 0.6–0.7 | 104 | 0.639 | 0.115 |
| 0.7–0.8 | 95 | 0.738 | 0.126 |
| 0.8–0.9 | 0 | n/a | n/a |
| 0.9–1.0 | 0 | n/a | n/a |

### Condition `E`

- n = 430
- ECE = 0.420 [0.395, 0.447]
- Brier = 0.264
- Verdict: **calibration not established** (gate failures: ece_above_0.05; ece_interval_upper_at_or_above_0.10)

| Bin | n | Mean Noul | Observed accurate |
|---|---|---|---|
| 0.0–0.1 | 8 | 0.068 | 0.000 |
| 0.1–0.2 | 18 | 0.155 | 0.000 |
| 0.2–0.3 | 34 | 0.258 | 0.000 |
| 0.3–0.4 | 45 | 0.347 | 0.000 |
| 0.4–0.5 | 51 | 0.450 | 0.000 |
| 0.5–0.6 | 82 | 0.546 | 0.012 |
| 0.6–0.7 | 100 | 0.644 | 0.120 |
| 0.7–0.8 | 69 | 0.740 | 0.290 |
| 0.8–0.9 | 21 | 0.838 | 0.714 |
| 0.9–1.0 | 2 | 0.915 | 1.000 |

## Choice accuracy (secondary)

| Condition | Correct | n | Rate | 95% Wilson |
|---|---|---|---|---|
| T | 0 | 0 | n/a | n/a |
| E | 374 | 430 | 87.0% | [83.5%, 89.8%] |

## Organic arm

Not supplied for this run.

## Limits

This measures one judge, one version, two conditions, and one question wording per condition, on
constructed defects. It says nothing about Jev on triage, routing, extraction, or any other task.
It does not compare Jev to Alfred's dual-control instrument on a shared task, because they do not
answer the same question: that instrument verifies provenance and this judge judges content. No
agreement figure with another model appears here, and none may be presented as calibration.
