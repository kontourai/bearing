# Catalog Contract

Status: accepted for the initial Bearing catalog slice.

## Decision

Bearing's smallest durable input is an immutable Capability Observation. Every
observation has an explicit model identity, source class, evidence references,
freshness, uncertainty, and one or more typed measurements. Evaluation
observations additionally require execution, task, and outcome scopes.

Unknown identity and execution dimensions are represented as `null`. This is
deliberate: absent data must remain distinguishable from a value Bearing inferred
from a model name.

Measurements declare whether they are facts or samples. The compiler surfaces
different overlapping fact values under one exact scope as a Conflict Set. It
retains different sample values without calling them conflicts.

Catalog compilation requires a caller-supplied `asOf`. It normalizes ordering,
computes observation ids, rejects duplicate observations, and hashes canonical
snapshot content. Identical inputs and `asOf` therefore produce byte-identical
content and digest.

## Consequences

- Bearing can represent external priors and first-party evals without pretending
  they have equal authority.
- Repeated benchmark runs remain available for later statistical derivation.
- Runtime-specific limits do not conflict with model-level declarations because
  their scopes differ.
- Ingestion layers must handle idempotent replays before invoking the strict
  compiler.
- Ranking remains a later deterministic projection over the retained record.
