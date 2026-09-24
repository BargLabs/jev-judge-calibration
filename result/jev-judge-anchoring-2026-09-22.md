# Jev-judge anchoring mechanism test — scope_mismatch

**These rates are on constructed defects built from public pull-request bodies, not on the
population of agent reports.** Each defective case was produced by a literal edit to a report's
text with its evidence left untouched, so the oracle is the construction and the numbers describe
the specimens. The D-series lesson applies directly: a rule firing on a constructed specimen is
evidence about the specimen, and a zero is never evidence that the subject is clean. This measures
one judge (`jev-1.13.0`), under two conditions, with one frozen question wording each.

This tests one mechanism on one defect class (scope_mismatch) and says nothing about the other
three labels. It measures the anchoring proposal against `docs/experiments/jev-judge-calibration-result-2026-09-20.md`'s
E:plain:scope_mismatch cell (46/50, 92.0%) — the one this card exists to explain.

Preregistration: `docs/experiments/jev-judge-anchoring-preregistration-2026-09-22.md`
Preregistration commit: `99e5a6e331f0437bf737844cfcfa4b628e0e2b6f` (blob `1f90983c59c5af8cf171d45620c523f539c30a53`)
Harness commit: `88be495389960c7544653bbc4cb75b5d1d4b945e`
Corpus digest: `c8d777ef059e4f1d368df004f6e3dd2a79e2fd9161aeefec63d0f78dd0d8517d`
Run window: 2026-09-23T18:29:17.970Z to 2026-09-23T18:39:28.948Z
Observed cost estimate: US$0.0196 across 467013 tokens
Observations: 592 across 50 base cases

## Arms

| Arm | Rendering |
|---|---|
| 0 | replication (primary E rendering unchanged) |
| 1 | list first (full evidence, changed-file list moved to the top of the evidence) |
| 2 | list only (evidence reduced to the changed-file list) |
| 3 | list only, false path adjacent (report truncated to the paragraph naming the false path) |

## Per-arm cost and wall-clock

| Arm | Calls | Mean input tokens | Estimated input tokens | Estimated cost | Wall-clock | Call log digest |
|---|---|---|---|---|---|---|
| 0 | 148 | 2048 | 163307 | US$0.0069 | 138768ms | `3788faaae972b0538237a80c6122475e0066ab8f5c6e679c8bacb90c901e6e42` |
| 1 | 148 | 2048 | 163307 | US$0.0069 | 140589ms | `1c8602693df44aedbe72b8e9972b4c2cfefc6089e8c07d80b3b2e14c4f50be8b` |
| 2 | 148 | 1196 | 98002 | US$0.0041 | 154834ms | `500f01bf82ec5d323933ac82d9ba984beef6a04882b4e147d4d7ae312053e17e` |
| 3 | 148 | 831 | 42397 | US$0.0018 | 176776ms | `172816607a7996eda5927a974fa7320cfb906a457d5097b9ef3aef3a62af58fd` |

## Scored predictions

A prediction whose replication gate (PA-0) did not pass is reported but marked
`not_interpreted_replication_failed` rather than scored — the preregistration states this in
advance rather than deciding after seeing the data.

| Prediction | Verdict | Measured |
|---|---|---|
| PA-0 | supported | arm0=94.0% [81.2%, 96.8%] target-n=50 |
| PA-1 | contradicted | arm2/arm0=0.702 [0.571, 0.830]; arm3/arm0=0.021 [0.000, 0.067] |
| PA-2 | contradicted | arm1/arm0=0.979 [0.933, 1.000] |
| PA-3 | supported | arm0=0.0%; arm1=0.0%; arm2=0.0%; arm3=0.0% |

## False-clear rate on scope_mismatch — P(noul ≥ 0.5)

The plain cell (n=50) is the headline measurement; the persuasive cell is reported alongside it but
is not itself scored by PA-0/PA-1/PA-2, which name the plain arm's 92.0% explicitly.

| Arm | Case arm | Cleared | n | Rate [95% Wilson] | Refusal |
|---|---|---|---|---|---|
| 0 | plain | 47 | 50 | 94.0% [83.8%, 97.9%] | — |
| 0 | persuasive | 22 | 48 | 45.8% [32.6%, 59.7%] | — |
| 1 | plain | 46 | 50 | 92.0% [81.2%, 96.8%] | — |
| 1 | persuasive | 20 | 48 | 41.7% [28.8%, 55.7%] | — |
| 2 | plain | 33 | 50 | 66.0% [52.2%, 77.6%] | — |
| 2 | persuasive | 18 | 48 | 37.5% [25.2%, 51.6%] | — |
| 3 | plain | 1 | 50 | 2.0% [0.4%, 10.5%] | — |
| 3 | persuasive | 2 | 48 | 4.2% [1.2%, 14.0%] | — |

## False-flag rate on clean cases — P(noul < 0.5)

| Arm | Flagged | n | Rate [95% Wilson] | Refusal |
|---|---|---|---|---|
| 0 | 0 | 50 | 0.0% [0.0%, 7.1%] | — |
| 1 | 0 | 50 | 0.0% [0.0%, 7.1%] | — |
| 2 | 0 | 50 | 0.0% [0.0%, 7.1%] | — |
| 3 | 0 | 50 | 0.0% [0.0%, 7.1%] | — |

## Choice accuracy (secondary)

| Arm | Correct | n | Rate | 95% Wilson |
|---|---|---|---|---|
| 0 | 147 | 148 | 99.3% | [96.3%, 99.9%] |
| 1 | 145 | 148 | 98.0% | [94.2%, 99.3%] |
| 2 | 147 | 148 | 99.3% | [96.3%, 99.9%] |
| 3 | 148 | 148 | 100.0% | [97.5%, 100.0%] |

## Limits

This tests one mechanism (anchoring on evidence size and position) on one defect class
(scope_mismatch), on one judge, one version, one question wording. It says nothing about the other
three labels (premature, fabricated_reference, wrong_count), about condition T, or about any judge
other than `jev-1.13.0`. A null result here (neither ratio moves) does not establish that no
mechanism exists — only that these two do not, on this corpus.
