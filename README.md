# Jev 1.13 as a judge of agent completion reports: the public record

Copies of the experiment records from the Barg Labs alfred repository at commit `47e6f24ffd29ec30fc2715b780ede7b92e122dd0`, mirrored 2026-09-21T12:43:58Z. The preregistration was frozen at alfred `af669cee`; the harness commit for the live run was alfred `0a8a04eb`; the corpus digest is in `corpus/corpus-manifest.json` and every file here is byte-identical to its original. Write-up: https://cejel.dev/experiments/jev-judge-2026-09-20/

Layout: the preregistration and three errata at the root; `result/` holds the unedited primary result and the post hoc secondary analysis; `harness/` holds the TypeScript harness and its tests as they were in the alfred `@alfred/bede` package (imports refer to that package's layout; this is a record of the code that ran, and it reads nothing from any Cejel scan path); `corpus/` holds the frozen corpus of constructed reports built from public pull-request bodies.

Not published under the disclosure boundary: the frame-exclusion file read by selection rule 2, the call log, and organic-arm material.
