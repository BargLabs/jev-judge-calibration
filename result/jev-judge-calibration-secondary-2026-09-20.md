# Jev 1.13 as a judge of agent completion reports — secondary analysis

**These rates are on constructed defects built from public pull-request bodies, not on the
population of agent reports.** Each defective case was produced by a literal edit to a report's
text with its evidence left untouched, so the oracle is the construction and the numbers describe
the specimens. The D-series lesson applies directly: a rule firing on a constructed specimen is
evidence about the specimen, and a zero is never evidence that the subject is clean. This measures
one judge (`jev-1.13.0`), under two conditions, with one frozen question wording each.

This is a post hoc secondary analysis, computed from the frozen call log after the primary
analysis was scored and published. No prediction was registered for any table below. The
primary result's metrics were reproduced exactly from this call log and the frozen corpus before
any table here was computed — a run that does not reproduce writes nothing.

Call log digest: `858ef19522765ed53353928ea8147d760e6eab861a81f4b1cd73b08a8845a5dd`
Corpus digest: `c8d777ef059e4f1d368df004f6e3dd2a79e2fd9161aeefec63d0f78dd0d8517d`
Primary harness commit: `0a8a04ebcb80394776abfc6809b36006eb0eec59`
Primary run window: 2026-09-20T23:19:04.962Z to 2026-09-20T23:23:00.782Z

## Label space and constant-answer baseline (condition E)

Choice accuracy in E (reproduced exactly from the primary): 374 / 430

| Truth label | n |
|---|---|
| accurate | 50 |
| premature | 100 |
| fabricated_reference | 100 |
| wrong_count | 82 |
| scope_mismatch | 98 |

Largest class: `premature` (n=100)
Constant-answer baseline: 100/430 = 23.3% [19.5%, 27.5%]

A binary split of this population (accurate vs. not) would report a different, higher baseline;
the figure above is the constant-answer baseline over the actual five-label space the Choice
question offers, and is the one this rate should be read against.

## Per-label Choice accuracy (condition E)

| Truth label | Arm | Correct | n | Rate |
|---|---|---|---|---|
| accurate | clean | 50 | 50 | 100.0% |
| accurate | pooled | 50 | 50 | 100.0% |
| premature | plain | 24 | 50 | 48.0% |
| premature | persuasive | 24 | 50 | 48.0% |
| premature | pooled | 48 | 100 | 48.0% |
| fabricated_reference | plain | 49 | 50 | 98.0% |
| fabricated_reference | persuasive | 50 | 50 | 100.0% |
| fabricated_reference | pooled | 99 | 100 | 99.0% |
| wrong_count | plain | 49 | 50 | 98.0% |
| wrong_count | persuasive | 32 | 32 | 100.0% |
| wrong_count | pooled | 81 | 82 | 98.8% |
| scope_mismatch | plain | 49 | 50 | 98.0% |
| scope_mismatch | persuasive | 47 | 48 | 97.9% |
| scope_mismatch | pooled | 96 | 98 | 98.0% |

## Confusion matrix — truth by pick (condition E)

| Truth \ Pick | accurate | premature | fabricated_reference | wrong_count | scope_mismatch |
|---|---|---|---|---|---|
| accurate | 50 | 0 | 0 | 0 | 0 |
| premature | 52 | 48 | 0 | 0 | 0 |
| fabricated_reference | 1 | 0 | 99 | 0 | 0 |
| wrong_count | 1 | 0 | 0 | 81 | 0 |
| scope_mismatch | 2 | 0 | 0 | 0 | 96 |

## Choice-by-Noul cross-tabulation on defective cases (condition E)

| Choice | Noul | n |
|---|---|---|
| right | cleared | 174 |
| right | flagged | 150 |
| wrong | cleared | 50 |
| wrong | flagged | 6 |

Share of correctly-labelled defects that were cleared by the separate Noul question (noul ≥ 0.5):
53.7%
