# Catalog Contract

Status: accepted; observation and catalog v2 supersede the unreleased v1 wire contract.

## Decision

Bearing's smallest durable input is an immutable Capability Observation. Every
observation has an explicit model identity, source class, evidence references,
freshness, uncertainty, and one or more typed measurements. Evaluation
observations additionally require execution, task, and outcome scopes.

Execution evidence is explicitly either `exact` or `partial`. Evaluations require
an exact scope and retain equality matching across the complete execution
profile. Declarations may use a partial scope: `null` dimensions are wildcards,
while present values are asserted. In particular, `toolSurface: null` means
unknown and `toolSurface: []` means known-empty. This distinction prevents a
provider declaration from inventing caller adapter, tools, hardware, or workflow.

Observation v1 encoded no scope kind and treated every non-null execution object
as exact. Catalog v1 therefore cannot be reinterpreted safely and is rejected;
producers must emit observation v2 and recompile catalog v2.

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
- Runtime-specific limits conflict only within the same canonical partial scope;
  model-global and differently scoped declarations remain separate.
- Ingestion layers must handle idempotent replays before invoking the strict
  compiler.
- Ranking remains a later deterministic projection over the retained record.
