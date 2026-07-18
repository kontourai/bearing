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

## Consequences

- Datum can apply local provider/auth/policy constraints around a reconstructable
  Bearing ranking instead of inheriting an opaque recommendation.
- Station and Flow Agents must supply truthful launchable inventories.
- A missing preference can reduce comparative information without excluding a
  candidate; missing hard-requirement evidence excludes conservatively.
- More sophisticated statistical models may become explicit versioned ranking
  policies later. They cannot silently change this deterministic policy.
