# Model Capability Intelligence - Shaped Backlog

Shaped: 2026-07-18

## Source Ideas

- Measure where smaller models stop matching larger models and whether Builder
  Kit changes that boundary.
- Maintain current external model/benchmark evidence instead of relying on a
  static reasoning-tier label.
- Intersect capability evidence with models a runtime can actually launch.
- Let Datum resolve roles from that evidence and expose the result as Station's
  Auto routing mode.
- Reuse portfolio primitives for source monitoring, extraction, review,
  evidence, freshness, and operational repair.

These ideas form one dependency chain: a capability catalog is independently
useful, while runtime-aware routing cannot be truthful without it.

## Product Decision

Create Bearing as a distinct model capability intelligence product. Bearing
owns model-domain observation normalization, deterministic catalog compilation,
history, and read/rank APIs. It does not own credentials, runtime discovery,
invocation, generic source mechanics, review authority, trust status, or
scheduling.

The thinnest meaningful slice is an offline, content-addressed catalog compiler.
Hosting and automated source refresh follow without blocking local consumers.

## Requirements And Success

- R1: Preserve model, execution, task, evaluator, cost, and provenance identity.
- R2: Retain evidence, freshness, uncertainty, and conflicting facts.
- R3: Compile and rank deterministically offline.
- R4: Rank only caller-supplied runtime candidates and explain exclusions.
- R5: Publish immutable versioned snapshots for caching.
- R6: Prefer deterministic structured adapters; keep LLM extraction reviewable.
- R7: Distinguish first-party eval measurements from external priors.

Success is a locally reproducible path from representative observations to a
validated snapshot and an explained selection constrained to live runtime
inventory, followed by matched fixed-vs-routed eval treatments.

## Boundaries

- Lookout owns source drift and proposal diffing.
- Traverse owns schema-directed extraction proposals.
- Survey owns source-to-candidate-to-review records.
- Surface owns claim/evidence/freshness meaning.
- Flow owns process transitions and the folded freshness trigger.
- Plumb monitors failed/stale operational checks.
- Evals owns independent task grading and produces first-party observations.
- Datum owns local provider/credential/role resolution and snapshot caching.
- Station owns runtime discovery, operator controls, and invocation.

## Delivery Map

- Bearing: [#1](https://github.com/kontourai/bearing/issues/1),
  [#2](https://github.com/kontourai/bearing/issues/2),
  [#3](https://github.com/kontourai/bearing/issues/3),
  [#4](https://github.com/kontourai/bearing/issues/4),
  [#5](https://github.com/kontourai/bearing/issues/5),
  [#6](https://github.com/kontourai/bearing/issues/6), and
  [#7](https://github.com/kontourai/bearing/issues/7).
- Datum: [#14](https://github.com/kontourai/datum/issues/14) and
  [#15](https://github.com/kontourai/datum/issues/15).
- Flow Agents: [#713](https://github.com/kontourai/flow-agents/issues/713),
  integrating existing [#416](https://github.com/kontourai/flow-agents/issues/416)
  and [#578](https://github.com/kontourai/flow-agents/issues/578).
- Station: [#422](https://github.com/kontourai/station/issues/422) and
  [#423](https://github.com/kontourai/station/issues/423).
- Evals: [#107](https://github.com/kontourai/evals/issues/107) and
  [#108](https://github.com/kontourai/evals/issues/108), preserving fixed-model
  controls in existing #42/#77.
- DNS: [kontourai-dns#6](https://github.com/kontourai/kontourai-dns/issues/6)
  for `bearing.kontourai.io` after the hosted target exists.

## Risks And Controls

- **Misleading universal score:** retain task-specific measurements and hard
  requirements; do not publish one quality scalar.
- **Stale or conflicting evidence:** retain source/freshness/conflicts and make
  stale/missing policy explicit in ranking.
- **Unavailable selections:** Datum intersects rankings with caller-supplied
  runtime inventory and local provider configuration.
- **Routing changes the benchmark:** routed treatments stay separately labeled;
  fixed bare/+kit and large-model controls remain intact.
- **Hosted dependency:** Datum caches validated immutable snapshots and operates
  offline during Bearing outages.
- **Primitive duplication:** add generic mechanics to their owning upstream
  product only when a concrete integration proves the need.

## Rollout And Rollback

Roll out offline compiler, read API, ranking, ingestion, Datum, Flow Agents,
Station, then hosting. Every hosted publication advances an immutable snapshot
pointer. Rollback selects a prior digest; it never rewrites history. Explicit
model assignments remain the local escape hatch throughout rollout.
