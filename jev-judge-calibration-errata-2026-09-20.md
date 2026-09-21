# Jev judge calibration — errata 1

Date: 2026-09-20
Refers to: `docs/experiments/jev-judge-calibration-preregistration-2026-09-19.md`, frozen at first-add commit `af669cee`
Status: recorded by the operator before the extension described below was read

## What happened

The first corpus build under the frozen selection procedure refused with `not_run: insufficient_base_cases:46`, exactly as the preregistration requires when fewer than 50 base cases survive.

Pool: 1,000 entries, the ten pages the frozen query permits. Of these, 101 were excluded before read by rules 1 and 2 (owner, frame membership; counts published only in aggregate). Of the 899 read, the first failing rule was:

| first failing rule | count |
|---|---|
| 6, body length outside [400, 8000] | 532 |
| 9, no check runs on the head commit | 151 |
| 3, archived | 35 |
| 8, changed-file count outside [1, 60] | 24 |
| 3, unreadable at read time | 1 |
| reached the admissibility filter | 156 |

Of the 156 that reached the filter, 46 survived it and rule 11. Admission rate over the pool: 4.6%.

The shortfall is a property of the pool, not of the rules: the earliest-created pull requests merged in the window are predominantly small repositories with short descriptions and no CI. The rules did what they were written to do.

## Decision

The GitHub search API returns at most 1,000 results per query, so the preregistered query cannot be paginated further. The pool is extended by appending a second frozen segment:

- Segment A: the original query, `sort=created`, `order=asc`, ten pages, as frozen. Unchanged; already read; its 46 survivors remain the first 46 base cases in pool order.
- Segment B: the identical query string with `sort=created`, `order=desc`, at most ten pages of 100. Appended after segment A in pool order. Duplicates of segment A entries (same repository and number) are dropped from B.

Every exclusion rule, the admissibility filter, rule 11 across the join, the construction rules, the question wording, the threshold, the metrics, the calibration gate and the five predictions are unchanged. The first 50 survivors in pool order are the corpus. If fewer than 50 survive the extended pool, the build refuses again and a second erratum is required; the pool is not extended a third time without one.

Expectation recorded before segment B is read: admission rate in segment B between 2% and 8%. If it falls outside that range the result records the fact; nothing else changes.

## Why this and not a wider query

A looser body-length or check-run rule would admit cases in which the author's own text carries a defect the construction rules assume absent, and would be a change to the instrument after seeing what it excluded. Adding a disjoint segment of the same population under the same rules changes the sample size and nothing else.

Signed by the operator.
