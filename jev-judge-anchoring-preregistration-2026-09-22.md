# Jev-judge anchoring mechanism test — scope_mismatch — pre-registration

Status: frozen before the first live call
Date: 2026-09-22
Protocol version: `jev-judge-v1`
Corpus: the frozen `jev-judge-calibration-2026-09-19-v1` corpus, unedited — no new selection, no
new construction, no new rewrite
Subject: `jev-1.13.0` (TypeSafe AI), pinned by versioned ID, unchanged from the primary
Result this tests: `docs/experiments/jev-judge-result-2026-09-20/jev-judge-calibration-result-2026-09-20.md`,
E:plain:scope_mismatch cell — 46/50, 92.0%, 95% Wilson [81.2%, 96.8%]
Proposed by: an outside reviewer, 2026-09-22, reading the primary result with no mechanism offered

Nothing in this document may be edited after the first live call. Corrections go to
`docs/experiments/jev-judge-anchoring-errata-<date>.md` and are cited from the result.

## Research question

Does the false-clear rate on scope_mismatch in condition E depend on the size of the evidence
record, or on the position of the changed-file list within it? The primary result found
scope_mismatch false-clearing *more* often with the evidence in context (E, plain: 92.0%) than
without it (T, plain: 62.0%) and offered no mechanism for that direction. The reviewer's proposal:
the evidence blob is large, the false file claim is one line in the report, and the model anchors
on "files were changed" — the general shape of the evidence — rather than checking whether the one
named path is a member of the specific changed-file set.

This is a measurement of one mechanism, on one defect class, on the same judge and corpus the
primary used. It says nothing about the other three labels (premature, fabricated_reference,
wrong_count), about condition T, or about any judge other than `jev-1.13.0`. If neither of the
predictions below holds, that is a finding: the mechanism is elsewhere, and the reviewer's own
fallback stands regardless — set membership is a deterministic job, which the companion card
`goal_alfred_jev_deterministic_baseline_arm_2026-09-22` measures on a model-free arm.

## Why this experiment exists

A judge that false-clears a false claim more often when handed the very evidence that contradicts
it is a specific, actionable failure mode if its cause is anchoring on evidence bulk — the fix is a
smaller or reordered prompt, not a different judge. It is a different failure mode if the cause is
something else — the persuasive arm's lower false-clear rate (43.8%) on the identical evidence
argues against a purely comprehension-based account and no candidate mechanism has yet been tested
against data. This card tests the one mechanism proposed so far, directly, before any change is
made to how the primary's prompt renders evidence.

## Subjects

The frozen corpus's 100 scope_mismatch cases (50 plain, 50 persuasive) and, as the control for
false flags, its 50 clean cases. 150 cases total. No new selection: `selectAnchoringSubjects`
(`packages/bede/src/jev-judge/anchoring.ts`) filters the already-frozen, already-committed corpus
by `variant === 'scope_mismatch'` and by `arm === 'clean'` — nothing is read from GitHub, rewritten,
or constructed for this card.

Noul and Choice questions are unchanged from the primary's condition E
(`JEV_NOUL_QUESTION_BY_CONDITION.E`, `JEV_CHOICE_INSTRUCTIONS`, `JEV_CHOICE_CRITERIA`); only the
`state` field's rendering varies by arm.

## Arms, in fixed run order

**Arm 0 — replication.** The primary's E rendering unchanged: report, then `---`, then
`EVIDENCE (JSON):`, then the full evidence record with sorted keys. Calls `corpus.ts`'s frozen
`renderState('E', subject)` directly. Measures run-to-run drift on the same 150 cases before
anything else is compared.

**Arm 1 — list first.** The full evidence, nothing removed, with the `changedFiles` key moved to
the front of the evidence JSON object instead of sitting alphabetically between `checkRuns` and
`commits`. Every other key keeps the primary's alphabetical order after it. This isolates
*position* from *size*: the evidence is exactly as large as Arm 0's.

**Arm 2 — list only.** The evidence reduced to the changed-file list alone — each entry's `path`,
`additions`, and `deletions`, sorted the same way the primary's `canonicalJson` sorts everything
else — and nothing else from the evidence record (repository, PR number, dates, SHAs, commit list,
check-run summary, linked references). The report is untouched.

**Arm 3 — list only, false path adjacent.** As Arm 2, with the report truncated to the one
paragraph (split on a blank line) that contains the false path — the backtick-quoted path token in
`falseClaim` (`` `This change also updates \`<PATH>\`.` ``) — so the claim and the reduced list are
the whole context. A clean case has no false claim and keeps its full report: there is no path to
be "adjacent" to, and truncating a clean report on an unrelated basis would confound the false-flag
control with an arbitrary cut. A defective case whose false path cannot be located in any single
paragraph (not expected by construction, but the persuasive rewrite is free text and does not
guarantee the false claim survives as its own paragraph) also keeps its full report rather than
emit an empty or truncated-by-accident state.

Renderers: `renderArm0State`, `renderArm1State`, `renderArm2State`, `renderArm3State`
(`packages/bede/src/jev-judge/anchoring.ts`), each a pure function of one `JevCase`, each
fixture-tested against checked-in expected bytes.

## Predictions, committed before the run and scored after

**PA-0 (replication gate).** Arm 0's scope_mismatch false-clear rate, plain arm only (n=50) —
the primary's headline cell — falls within the primary's stated 95% Wilson interval,
[81.2%, 96.8%]. If it does not, PA-1 and PA-2 are still computed and reported in full, but their
verdict is recorded as `not_interpreted_replication_failed` rather than scored: a replication
outside the interval on the same pinned model and prompt is an open question about vendor drift,
and whether to re-run the whole primary on all 430 E cases is an operator decision taken in
writing, never something this card or the harness decides on its own. PA-3 does not depend on this
gate — the false-flag ceiling is evaluated regardless, since it tests the reduction's precision
cost, not the anchoring mechanism's replication.

**PA-1 (size).** If the mechanism is anchoring on evidence size: Arm 2's plain scope_mismatch
false-clear rate is at most half of Arm 0's, and Arm 3's is at most a quarter of Arm 0's. Both
ratios are scored on a paired cluster bootstrap over base cases (the same 50 base cases appear in
every arm), 10,000 resamples, using the seeded PRNG already exported from `metrics.ts`
(`createRandom`) — reused, not reimplemented. A ratio's 95% percentile interval wholly at or below
its threshold is `supported`; wholly above is `contradicted`; straddling is `not_evaluable`.

**PA-2 (position).** If the mechanism is position: Arm 1's plain scope_mismatch false-clear rate is
at most half of Arm 0's. Scored the same way as PA-1's ratios.

**PA-3 (false-flag control).** The clean false-flag rate does not rise above 10% in any of the four
arms. A rise means the reduction bought recall (fewer false clears) at the cost of precision (more
false flags on clean reports) and is reported as such, not folded into PA-1/PA-2's verdicts.

These two ratio families — the size ratio (Arm 2/Arm 0, Arm 3/Arm 0) and the position ratio
(Arm 1/Arm 0) — are the two ratios this card reports intervals for beyond the per-arm rate tables
themselves.

## Metrics published, per arm

- False-clear rate on scope_mismatch, plain and persuasive separately, with 95% Wilson intervals.
  The plain cell is the headline measurement PA-0/PA-1/PA-2 score against; the persuasive cell is
  reported alongside for completeness and is not itself scored by name.
- False-flag rate on the 50 clean cases, with a 95% Wilson interval.
- Choice accuracy against the variant label, as a secondary.
- Mean input tokens, estimated cost, and wall-clock time.
- The size ratio and the position ratio, each with a 95% bootstrap percentile interval.

## Cost

600 calls total (150 cases × 4 arms), most well under the primary's E token budget (3,400 tokens):
Arms 1–3 are the same size as or smaller than Arm 0, and Arm 0 is exactly the primary's E
rendering. Frozen budget for the pre-run estimate: `150 × 4 × 3,400 = 2,040,000` tokens —
Arm 0's per-call budget applied to every arm and every case, which is already a ceiling rather than
a measured figure, since Arms 1–3 never exceed Arm 0's size.

`2,040,000 × US$0.042 / 1,000,000 ≈ **US$0.086**`. The harness recomputes the estimate from the
corpus's actual state lengths under each arm's renderer and prints that figure beside this one; a
divergence above 3× aborts the run rather than spending, recorded as
`not_run: cost_estimate_exceeds_budget` — the same abort multiple the primary uses, unchanged.

## Limits

This tests one mechanism (anchoring on evidence size and position) on one defect class
(scope_mismatch), on one judge, one version, one question wording, using the already-frozen
primary corpus. It says nothing about the other three labels, about condition T, or about any judge
other than `jev-1.13.0`. A null result — neither ratio moves the false-clear rate — does not
establish that no mechanism exists, only that these two specific ones do not, on this corpus. These
rates are on constructed defects built from public pull-request bodies, not on the population of
agent reports: the D-series lesson applies directly, and a rule (or a rendering) that changes a
constructed specimen's rate is evidence about the specimen, never proof about the population.

## Publication

Published: this methodology, the four renderers' source and fixture bytes, the per-arm metrics, the
scored predictions, and the harness source. Never published under any framing: adjudication labels,
reviewer notes, evidence corpora, live Cejel frame membership, Alfred implementation material,
keys, counterparty specifics. Authority: the operator's disclosure boundary decision, 2026-08-18.

## Refusal states

- `TYPESAFE_API_KEY` absent (live path only) → `not_run: missing_api_key`.
- A response's `model` field is not `jev-1.13.0` → `not_run: model_mismatch`, before the next call.
- The commit that first added this pre-registration file is not a strict ancestor of `HEAD` →
  `not_run: preregistration_not_ancestor`, resolved the same way the primary's guard resolves it
  (`git log --reverse --diff-filter=A`, not the file's most recent commit).
- This file's current bytes do not hash to its blob at that first-add commit →
  `not_run: preregistration_modified_after_freeze`.
- The frozen corpus's digest disagrees with `corpus-manifest.json` → `not_run: corpus_digest_mismatch`
  (the existing guard in `corpus.ts`, reused unedited).
- The selected subject count is not exactly 150 →
  `not_run: anchoring_subject_count_unexpected:<n>`.
- The recomputed cost estimate exceeds three times the budget above →
  `not_run: cost_estimate_exceeds_budget`.

A refusal is a recorded outcome with a reason, not a silent no-op, and not a zero.

## Commit and run order

1. Commit this pre-registration **alone and first**, so it is a strict ancestor of everything else.
2. Commit the harness (`anchoring.ts`, the `cli.ts` wiring) and its renderer fixture tests.
3. Execute the frozen harness from a commit that descends from both of the above, against the
   already-frozen corpus — no corpus build step for this card.
4. Put the result in a later commit and a separate pull request from the harness.
5. Publish the result even when it is null, adverse, or refused.
