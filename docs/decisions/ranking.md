# Runtime-Aware Ranking

Status: accepted for the initial Bearing ranking surface.

## Decision

Bearing ranks only the candidate inventory supplied by its caller. It never
discovers, expands, or invokes that inventory. A request declares a task family,
hard requirements, and weighted preferences. Hard requirements exclude first;
preferences normalize numeric evidence across the surviving request candidates.

Every criterion names an explicit aggregation. `fact` requires one agreed value
from current evidence. `mean`, `min`, `max`, `success-rate`, and `count` operate
on sample measurements; `count` lets hard requirements enforce minimum evidence
volume. Missing, stale, conflicting, and incomparable evidence remain
distinct reason codes. Result evidence references the contributing observation
and evidence ids.

Measurements retained on an evaluation whose outcome is `invalid` never enter
ranking aggregation. Invalid runs remain auditable catalog diagnostics, but
cannot satisfy requirements, affect sample counts, or contribute preference
scores regardless of their measurement key.

Requirements and preferences may independently filter `sourceClasses`. This
keeps external priors available for declared facts without silently averaging
them into first-party measured outcomes.

Preference scores are request-relative. The result declares its maximum weight
and scope and is not a universal model-quality score. Identical validated
catalog and normalized request inputs produce identical ordering, reasons, and
scores; ties break by caller candidate id.

The public API uses the same prepared ranker as the library. It validates and
indexes one immutable snapshot once, supports CORS preflight, and bounds request
bodies. It performs no network access or model invocation while ranking.

The version 2 request adds advisory projections. An advisory has a stable
caller-owned id and explicitly names a measurement, aggregation, and optional
source-class filter. Bearing projects it for every ranked and excluded
candidate using the same applicability, freshness, conflict, and aggregation
rules as ranking criteria. Results distinguish `present`, `missing`, `stale`,
`conflicting`, and `incomparable`; only present projections carry a scalar
value and its agreed unit, while every projection carries evidence and
uncertainty. Unit-sensitive aggregations require all contributing measurements
to agree on the unit, including whether a unit is absent. Bearing does not
silently convert units; mixed or partial units are incomparable. Derived
`count` and `success-rate` values are unitless.

Advisories are observational only. They cannot affect hard requirements,
preference scores, eligibility, ordering, score scale, or version 1 output.
This lets a downstream resolver consume trusted benchmark or provider facts
without guessing measurement keys from model names or reimplementing Bearing's
evidence semantics.

Version 2 bounds candidate, criterion, and advisory counts and independently
bounds the candidate-by-advisory projection cells. These structural limits
apply before projection so a bounded request body cannot amplify into an
unbounded result. Advisory lookup uses a prepared per-model measurement index.
Version 1 validation remains unchanged apart from shared rejection of inherited
or accessor-backed request fields.

The Web handler reads request bodies incrementally, stops at its byte limit,
bounds serialized rank responses, and limits concurrent rank work per prepared
handler. Identity-aware quotas and distributed rate limiting remain an ingress
responsibility because Bearing does not own callers or authentication. HTTP
resource version `/v1/rank` intentionally accepts both v1 and v2 rank message
schemas; message versions, not the URL, select the result contract.

## Consequences

- Datum can apply local provider/auth/policy constraints around a reconstructable
  Bearing ranking instead of inheriting an opaque recommendation.
- Station and Flow Agents must supply truthful launchable inventories.
- A missing preference can reduce comparative information without excluding a
  candidate; missing hard-requirement evidence excludes conservatively.
- A missing advisory remains usable diagnosis and does not exclude a candidate.
- More sophisticated statistical models may become explicit versioned ranking
  policies later. They cannot silently change this deterministic policy.
