# Jev 1.13 composed clearing — Arm A (post hoc re-scoring of the frozen log)

**These rates are on constructed defects built from public pull-request bodies, not on the
population of agent reports.** Each defective case was produced by a literal edit to a report's
text with its evidence left untouched, so the oracle is the construction and the numbers describe
the specimens. The D-series lesson applies directly: a rule firing on a constructed specimen is
evidence about the specimen, and a zero is never evidence that the subject is clean. This measures
one judge (`jev-1.13.0`), under two conditions, with one frozen question wording each.

This is a post hoc re-scoring of the frozen call log under a stated rule: the clearing score is
`answers.variant.probabilities.accurate`, the Choice answer's own probability of `accurate`,
never a new call. Prediction P2c-A was registered in
`docs/experiments/jev-judge-composition-preregistration-2026-09-22.md` before this number was
computed. The primary result's metrics were reproduced exactly from this call log and the frozen
corpus before any table here was computed — a run that does not reproduce writes nothing.

Call log digest: `858ef19522765ed53353928ea8147d760e6eab861a81f4b1cd73b08a8845a5dd`
Corpus digest: `c8d777ef059e4f1d368df004f6e3dd2a79e2fd9161aeefec63d0f78dd0d8517d`
Primary harness commit: `0a8a04ebcb80394776abfc6809b36006eb0eec59`
Primary run window: 2026-09-20T23:19:04.962Z to 2026-09-20T23:23:00.782Z
Composed observations (condition E): 430

## P2c-A

From the frozen log, using p(accurate) from the Choice probabilities as the clearing score at threshold 0.5, the false-clear rate on wrong_count and on scope_mismatch is at most 20%, and on premature it is higher than both.

| Prediction | Verdict | Measured |
|---|---|---|
| P2c-A | supported | wrong_count=1.2% [0.2%, 6.6%] n=82; scope_mismatch=1.0% [0.2%, 5.6%] n=98; premature=45.0% [35.6%, 54.8%] n=100 |
| | | _Composed clearing score p(accurate) from the Choice answer, pooled across the plain and persuasive arms — the same population the Choice-by-Noul cross-tab scores. The two at-most clauses are scored on their 95% Wilson intervals against 0.20; the ordering clause compares point estimates._ |

Any number under 5% on a label the Noul cleared above 80% is checked once more against the raw
probabilities before it is believed.

## Composed false-clear rate — P(p(accurate) ≥ 0.5 | defective)

A cell with zero false clears, or a perfect one, is treated as possible construction leakage: the
counts are printed and the rate is withheld.

| Variant | Arm | Cleared | n | Rate [95% Wilson] | Refusal |
|---|---|---|---|---|---|
| premature | plain | 25 | 50 | 50.0% [36.6%, 63.4%] | — |
| premature | persuasive | 20 | 50 | 40.0% [27.6%, 53.8%] | — |
| premature | pooled | 45 | 100 | 45.0% [35.6%, 54.8%] | — |
| fabricated_reference | plain | 0 | 50 | WITHHELD | possible_construction_leakage:fabricated_reference:plain |
| fabricated_reference | persuasive | 0 | 50 | WITHHELD | possible_construction_leakage:fabricated_reference:persuasive |
| fabricated_reference | pooled | 0 | 100 | WITHHELD | possible_construction_leakage:fabricated_reference:pooled |
| wrong_count | plain | 1 | 50 | 2.0% [0.4%, 10.5%] | — |
| wrong_count | persuasive | 0 | 32 | WITHHELD | possible_construction_leakage:wrong_count:persuasive |
| wrong_count | pooled | 1 | 82 | 1.2% [0.2%, 6.6%] | — |
| scope_mismatch | plain | 0 | 50 | WITHHELD | possible_construction_leakage:scope_mismatch:plain |
| scope_mismatch | persuasive | 1 | 48 | 2.1% [0.4%, 10.9%] | — |
| scope_mismatch | pooled | 1 | 98 | 1.0% [0.2%, 5.6%] | — |

## Calibration against outcomes — condition E, composed score

- n = 430
- ECE = 0.175 [0.158, 0.196]
- Brier = 0.074
- Verdict: **calibration not established** (gate failures: ece_above_0.05; ece_interval_upper_at_or_above_0.10)

| Bin | n | Mean composed score | Observed accurate |
|---|---|---|---|
| 0.0–0.1 | 176 | 0.029 | 0.000 |
| 0.1–0.2 | 50 | 0.136 | 0.000 |
| 0.2–0.3 | 42 | 0.243 | 0.000 |
| 0.3–0.4 | 37 | 0.341 | 0.000 |
| 0.4–0.5 | 28 | 0.445 | 0.000 |
| 0.5–0.6 | 27 | 0.553 | 0.037 |
| 0.6–0.7 | 19 | 0.641 | 0.053 |
| 0.7–0.8 | 4 | 0.762 | 0.750 |
| 0.8–0.9 | 22 | 0.859 | 0.955 |
| 0.9–1.0 | 25 | 0.936 | 0.960 |

## Choice-by-composed cross-tabulation on defective cases (condition E)

Same shape as the Choice-by-Noul cross-tab in the secondary analysis, with the composed score in
place of the independently-asked Noul.

| Choice | Composed clearance | n |
|---|---|---|
| right | cleared | 0 |
| right | flagged | 324 |
| wrong | cleared | 47 |
| wrong | flagged | 9 |

Share of correctly-labelled defects cleared by the composed score (p(accurate) ≥ 0.5):
0.0%

## What this does and does not show

If this number brings the false-clear rate under the pre-registered ceiling, the fix is a wire-shape
choice — the information was already in the log — and Arm B (the live, forced-order run) exists to
confirm it. If it does not, the model's label probabilities are themselves miscalibrated on this
population, and Arm B is the real test, not a formality.
