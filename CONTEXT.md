# Bearing Context

Bearing maintains evidence-backed model capability observations and compiles
them into versioned catalogs. It answers what current evidence says a model can
do under a disclosed execution and task scope. Datum answers which configured,
available model should satisfy a role locally. Station and other runtimes own
availability discovery and invocation.

## Language

**Model Identity**: A model id plus explicit revision and quantization. Revision
and quantization may be `null` when unknown, but may not be inferred from the
display id.

**Execution Profile**: The runtime, adapter, effective context, tool surface,
hardware class, and workflow condition under which an observation was made.
Model-level declarations may have no execution profile; evaluation observations
must have one.

**Task Profile**: The task family, suite/task identity, and evaluator that give
an observation its behavioral scope.

**Capability Observation**: One immutable, provenance-bearing record about a
model. An observation carries measurements, evidence, freshness, and uncertainty.
Evaluation observations also carry an outcome and execution/task profiles.

**Fact Measurement**: A source assertion intended to hold for its exact model,
execution, and task scope, such as a declared maximum context. Different values
for the same overlapping fact scope form a Conflict Set.

**Sample Measurement**: One measured result, such as a benchmark task outcome or
latency. Different sample values are observations of variation, not conflicts.

**Catalog Snapshot**: A deterministic, content-addressed compilation of valid
observations at a caller-supplied `asOf`. It retains observations and conflict
sets and performs no model ranking by itself.

**Runtime Inventory**: A caller-owned list of models it can actually launch.
Bearing may rank that list but never discovers or expands it.

## Product Boundary

- Evals and external adapters produce observations.
- Forage/Lookout fetch, authenticate snapshot acquisition, and detect source
  drift. Bearing source adapters validate the handed-off binding but do not
  independently establish network origin.
- Traverse proposes fields from unstructured content.
- Survey carries candidate/review records.
- Surface derives trust status and freshness meaning.
- Flow owns scheduling and process transitions; Plumb monitors operational checks.
- Bearing normalizes model-domain observations and publishes catalogs/rankings.
- Datum combines catalogs with local providers, credentials, roles, and runtime
  inventory.
- Station discovers runtime availability, presents Auto routing, and invokes.
