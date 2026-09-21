# Jev judge calibration — errata 3

Date: 2026-09-20
Refers to: `docs/experiments/jev-judge-calibration-preregistration-2026-09-19.md`, frozen at first-add commit `af669cee`; errata 1 and 2 of the same date
Status: recorded by the operator before any persuasive rewrite has been accepted

## What happened

The preregistration's "Persuasive rewrite" section freezes the rewriting call as `claude-sonnet-5`, `temperature: 0`, `max_tokens: 2048`, one user message, no system prompt. On 2026-09-20 every rewrite call was rejected by the Anthropic Messages API with HTTP 400, `invalid_request_error`: `temperature` is deprecated for this model. The builder, since #1674, refused correctly with `not_run: persuasive_arm_empty:rewrite_http_error:400`. Two hundred rewrites were attempted per build; none reached the model. The frozen parameter list is not executable against the vendor as it stands.

## Decision

The `temperature` parameter is omitted from the rewrite request. Model, `max_tokens`, message shape and the prompt template are unchanged; the prompt digest in the corpus is unchanged. The corpus records the parameters actually sent.

## Why this changes nothing the design relies on

The preregistration states that the API exposes no seed, that the rewrite is therefore not reproducible by re-derivation, and that determinism is secured by freezing every rewritten report into the corpus and pinning its digest. `temperature: 0` was an attempt at repeatability the preregistration had already declared it does not depend on. Removing it leaves the frozen-bytes guarantee exactly where it was. The verbatim guard, the drop accounting, the questions, the threshold, the metrics, the calibration gate and the five predictions are unchanged.

Signed by the operator.
