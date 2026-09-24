# Erratum 1 to the anchoring preregistration (2026-09-22), signed before any live call

Preregistration: `docs/experiments/jev-judge-anchoring-preregistration-2026-09-22.md` (unchanged; its freeze guard forbids editing it).

What was wrong. The preregistration states the subjects as "the frozen corpus's 100 scope_mismatch cases (50 plain, 50 persuasive) and its 50 clean cases, 150 cases total", and freezes the guard "selected subject count is not exactly 150". The frozen corpus manifest records 48 persuasive scope_mismatch cases, not 50: two rewrites failed the verbatim-preservation guard and were dropped and counted, as the primary result of 2026-09-20 already states (20 of 200 dropped). The correct subject count is 148 (50 + 48 + 50), and the call count is 592 (148 x 4), within the frozen budget.

How it surfaced. On the first live attempt, 2026-09-23, the guard refused with `not_run: anchoring_subject_count_unexpected:148` before any call was made. No call was placed and no result exists.

Correction. `JEV_ANCHORING_EXPECTED_SUBJECT_COUNT` in `packages/bede/src/jev-judge/anchoring.ts` becomes 148, with this erratum cited beside it. `selectAnchoringSubjects` is unchanged; the population is exactly the one the preregistration names, the number attached to it was miscounted. Nothing else in the preregistration changes: arms, renderers, questions, threshold, predictions PA-0 to PA-3, budget rule and refusal states all stand.

Why this is an erratum and not a re-freeze. The count is a description of a corpus that was already frozen and digest-pinned before the preregistration was written; the preregistration mis-described it. The same class as errata 1 to 3 on the primary: selection and construction mechanics, no question, threshold or prediction touched.

Operator: Houman Azimi. Signed at: 2026-09-23 (London), before the anchoring run.
