# Jev 1.13 composed clearing — Arm B (live, Choice before Noul)

**These rates are on constructed defects built from public pull-request bodies, not on the
population of agent reports.** Each defective case was produced by a literal edit to a report's
text with its evidence left untouched, so the oracle is the construction and the numbers describe
the specimens. The D-series lesson applies directly: a rule firing on a constructed specimen is
evidence about the specimen, and a zero is never evidence that the subject is clean. This measures
one judge (`jev-1.13.0`), under two conditions, with one frozen question wording each.

Live run. The prompt asked the Choice question first, then the Noul question worded to be the
probability that the label just given is `accurate`
(`docs/experiments/jev-judge-composition-preregistration-2026-09-22.md`). One call per
condition-`E` case; no condition-`T` calls are made by this arm.

Composition pre-registration commit: `d58c9dbd2701414b370774551082d5bce303f3fd` (blob `e5b149cfe77ca6dab1e011c17c8d34e0cb003222`)
Harness commit: `21b3af59f7823711073c5ff27c24f4e9eb983424`
Corpus digest: `c8d777ef059e4f1d368df004f6e3dd2a79e2fd9161aeefec63d0f78dd0d8517d`
Call log digest: `71dc3be9ec73f107e8ecb042ae9a1a646b91cb3a219958282cc5e6241c7d32b8`
Run window: 2026-09-23T17:29:36.114Z to 2026-09-23T17:31:52.015Z
Observed input tokens (estimated): 491285; cost US$0.0206
Observations: 430

Every response's `model` field was checked against `jev-1.13.0` before its answer was recorded.

## Scored predictions

| Prediction | Verdict | Measured |
|---|---|---|
| P2c-B | contradicted | wrong_count=48.8% [38.3%, 59.4%] n=82; scope_mismatch=59.2% [49.3%, 68.4%] n=98 |
| | | _The live arm's own Noul, asked after the Choice, wired to the question in `JEV_COMPOSITION_NOUL_QUESTION`. Pooled across the plain and persuasive arms. Scored on the 95% Wilson interval against 0.20._ |
| P2c-C | supported | arm_b_choice_accuracy_E=86.7%; primary_choice_accuracy_E=87.0%; |diff|=0.3% |
| | | _Point-estimate comparison against the primary's published condition-E Choice accuracy (374/430 ≈ 87.0%), not an interval test: the prediction is about closeness to a fixed figure, not a one-sided threshold._ |

## False-clear rate — P(noul ≥ 0.5 | defective), the live composed Noul

| Variant | Arm | Cleared | n | Rate [95% Wilson] | Refusal |
|---|---|---|---|---|---|
| premature | plain | 29 | 50 | 58.0% [44.2%, 70.6%] | — |
| premature | persuasive | 1 | 50 | 2.0% [0.4%, 10.5%] | — |
| premature | pooled | 30 | 100 | 30.0% [21.9%, 39.6%] | — |
| fabricated_reference | plain | 39 | 50 | 78.0% [64.8%, 87.2%] | — |
| fabricated_reference | persuasive | 13 | 50 | 26.0% [15.9%, 39.6%] | — |
| fabricated_reference | pooled | 52 | 100 | 52.0% [42.3%, 61.5%] | — |
| wrong_count | plain | 38 | 50 | 76.0% [62.6%, 85.7%] | — |
| wrong_count | persuasive | 2 | 32 | 6.3% [1.7%, 20.1%] | — |
| wrong_count | pooled | 40 | 82 | 48.8% [38.3%, 59.4%] | — |
| scope_mismatch | plain | 45 | 50 | 90.0% [78.6%, 95.7%] | — |
| scope_mismatch | persuasive | 13 | 48 | 27.1% [16.6%, 41.0%] | — |
| scope_mismatch | pooled | 58 | 98 | 59.2% [49.3%, 68.4%] | — |

## Calibration against outcomes — condition E

- n = 430
- ECE = 0.378 [0.355, 0.403]
- Brier = 0.229
- Verdict: **calibration not established** (gate failures: ece_above_0.05; ece_interval_upper_at_or_above_0.10)

## Choice accuracy, with the constant-answer baseline beside it

Choice accuracy: 373/430 = 86.7%
Constant-answer baseline (five-label space): 100/430 = 23.3%

## Choice-by-Noul cross-tabulation on defective cases

| Choice | Noul | n |
|---|---|---|
| right | cleared | 155 |
| right | flagged | 168 |
| wrong | cleared | 25 |
| wrong | flagged | 32 |

Share of correctly-labelled defects cleared by the forced-order Noul (noul ≥ 0.5):
48.0%
