# Operator approval: Jev composition Arm B and anchoring run, 2026-09-23

Approved for live execution against jev-1.13.0, from a commit descending from this one:

1. Composition Arm B (`docs/experiments/jev-judge-composition-preregistration-2026-09-22.md`), 430 calls, budget as frozen there.
2. Anchoring run (`docs/experiments/jev-judge-anchoring-preregistration-2026-09-22.md`), 600 calls, four arms, budget as frozen there. Arm 0 is a replication of the primary's 150 scope_mismatch and clean E cases; whether the primary is re-run if Arm 0 falls outside the primary's intervals is a separate operator decision, not granted here.

Erratum to the composition preregistration: its "Operator signature" section cannot be completed in place, because the runner refuses Arm B when the file's bytes differ from its first-add blob. The signature is this record, carried by an operator-signed commit, in place of the in-file block. The preregistration is otherwise unchanged.

Operator: Houman Azimi. Signed at: 2026-09-23 (London).
