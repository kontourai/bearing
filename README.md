# @kontourai/bearing

Evidence-backed model capability intelligence. Bearing accepts provenance-bearing
model observations, compiles them into deterministic catalog snapshots, and
supports runtime-aware ranking without invoking models.

Bearing answers **what current evidence says a model can do**. It does not own
provider credentials, discover a caller's launchable models, or make model calls.
Datum combines Bearing snapshots with local configuration and runtime inventory;
Station and other runtimes consume that resolution.

## Status

The catalog, read API, and runtime-aware ranking contracts are available. See
[Bearing issue #1](https://github.com/kontourai/bearing/issues/1) for the
remaining ingestion and hosted-service delivery graph.

## Read API

The core exports a Web-standard request handler, while `@kontourai/bearing/node`
provides an optional local server adapter. Both serve the same validated,
content-addressed snapshot.

```sh
bearing serve --catalog ./catalog.json --host 127.0.0.1 --port 4244 \
  --max-concurrent-rank-requests 4 --max-rank-response-bytes 8388608
curl http://127.0.0.1:4244/v1/models
curl http://127.0.0.1:4244/v1/catalog/snapshot
```

The API supports `GET`, `HEAD`, `ETag`, and `If-None-Match`. Model list entries
carry a stable model key; `GET /v1/models/<key>` returns the complete retained
observations, evidence references, and conflict sets for that identity.
Rank bodies are read incrementally with a 1 MiB limit. Rank responses and
concurrent rank work are bounded by configurable handler budgets; deployments
remain responsible for identity-aware rate limiting at their ingress.

## Runtime-Aware Ranking

`rankCatalog` and `POST /v1/rank` evaluate only candidates supplied in the
request's runtime inventory. Hard requirements exclude candidates before
preferences contribute to a request-relative score. Results retain observation
and evidence ids and explain missing, stale, conflicting, incomparable, and
unsatisfied evidence.

Supported aggregations are `fact`, `mean`, `min`, `max`, `success-rate`, and
`count`. Facts must agree within their exact model/execution/task scope. Sample
aggregations retain measured variation; `count` lets a policy enforce a minimum
sample volume. A prepared `createCatalogRanker`
validates and indexes one snapshot once for repeated local resolutions.
Each requirement or preference may filter `sourceClasses`, so a policy can use
external declarations for model facts while scoring completion from first-party
measurements only.

Scores are explicitly request-relative and must not be compared across
different inventories, requirements, preferences, or snapshot digests.

Version 2 rank requests may also declare caller-owned `advisories`. Each
advisory projects one explicitly named measurement and aggregation onto every
ranked or excluded inventory candidate. The projection reports `present`,
`missing`, `stale`, `conflicting`, or `incomparable`, together with evidence and
uncertainty. Scalar fact values, including strings, are returned only when
present. Present projections also return the agreed measurement unit, or
`null` for unitless and derived aggregations. Mixed or partially declared units
are incomparable rather than silently averaged. Advisories never change
requirements, eligibility, scores, ordering,
or the version 1 result shape; they let Datum and other consumers use benchmark
and provider facts without duplicating Bearing's scope, freshness, conflict, or
source-class logic.

The `/v1/rank` path is the version of the HTTP resource, while
`bearing.rank.request/v1` and `/v2` are versions of the message contract. The
same endpoint accepts both message versions and returns the corresponding
result version.

## Trusted Source Ingestion

`importAiderPolyglotSnapshot` converts explicitly mapped rows from the official
Aider Polyglot leaderboard into scoped external observations. It never fuzzy
matches model labels. Unmapped rows remain diagnostics, and missing or
impossible measurements are not invented.

The adapter accepts only a full-envelope `forage-snapshot:` reference bound to
the immutable raw GitHub URL for the supplied commit and body digest. Bearing
checks that binding but does not fetch or independently authenticate the origin;
the input must come from a successful exact Forage/Lookout replay. Acquisition
provenance is returned separately from stable observations so re-fetching the
same source bytes cannot double-weight one benchmark run. Observation evidence
uses content-addressed source and row URNs; the acquisition record retains the
exact commit-qualified URL and full snapshot reference needed to audit origin.

`importKontourEvalsResults` converts first-party
`kontour.console.economics` JSONL records into scoped observations. Every run
requires an exact reviewed mapping for model revision, quantization, runtime,
adapter, tool surface, context, hardware, workflow version, and evaluator; the
adapter never derives those dimensions from a display name. Independent grader
acceptance remains separate from Builder Kit engagement qualification, so a
workflow-not-engaged result can retain its task outcome without becoming
evidence of Kit effect. Missing runner evidence, dry runs, and nonzero runner
exits become invalid outcomes; invalid evaluation measurements remain retained
for diagnosis but are excluded from all Bearing ranking aggregations.

Token fields remain `complete`, `partial`, or `unknown` according to the
runner-owned usage signal. The Evals v0.1 record does not distinguish a true
zero-dollar run from unavailable pricing, so estimated cost remains available
through the content-addressed source record but is not promoted to a Bearing
measurement. Source-set, per-record, grader, and optional Kit-provenance digests
keep the normalized observation auditable without adding an Evals runtime
dependency to Bearing.

`importLiveBenchSnapshots` applies the same boundary to LiveBench's official,
release-addressed score table and category manifest. Both artifacts must arrive
as successful exact Forage/Lookout resolutions; Bearing recomputes each full
snapshot envelope before parsing the bytes it commits. Full artifact references
remain in the acquisition record, while catalog observations carry stable
content-addressed task-result, category-assignment, and exact mapping-entry
evidence. This prevents an unrelated row correction from changing or
double-weighting an unchanged task result.

Every accepted model mapping becomes one sample per exact task, with the
category-derived task family and runtime/workflow condition retained. Category
semantics remain filterable through keys such as `livebench.coding.score` and
`livebench.agentic-coding.score`; there is deliberately no aggregate
"LiveBench quality" measurement. Lookout owns acquisition authentication and
the calling refresh policy owns mapping-review acceptance. Bearing owns exact
binding, deterministic normalization, and transparent mapping evidence. CSV
schema drift, duplicate rows or tasks, duplicate JSON keys, unknown categories,
invalid scores, mismatched releases, and excessive parse or observation
expansion fail closed; unmapped model rows remain explicit diagnostics.

## Development

```sh
npm install
npm run verify
```

Node.js 22 or newer is required. Trusted structured-source adapters use bounded
YAML, CSV, and duplicate-aware JSON parsing. The LiveBench adapter composes the
canonical snapshot-envelope contract from `@kontourai/forage`; it does not
duplicate that provenance algorithm. Catalog, ranking, API, and source-adapter
paths remain deterministic and do not perform network access.

## Trusted source discovery

`sources/approved-sources.v1.json` is the reviewed trust-onboarding manifest for
external model-intelligence sources. Runtime discovery may find a new resource
or release only within a source's approved origin, closed resolver adapter, and
artifact templates. Discovery never adds a source, trusts a model label, or
contributes a benchmark row by itself.

The first resolver follows LiveBench's official index to its current same-origin
hashed main bundle, then derives the release set and manifest-bound artifact
locators from exact Forage/Lookout snapshot envelopes. The bundle name is not
hard-coded. New releases and unknown model rows are review proposals; only exact
reviewed model mappings can enter `importLiveBenchSnapshots`.

Acquisition remains outside the offline catalog core. Lookout and Forage guard
network access, persist immutable snapshots, and replay exact references.
Bearing validates those envelopes, performs deterministic model-domain
discovery/import, and ranks only caller-supplied runtime inventory.

## Releases

Package contents are checked by `npm run verify`. Release Please and npm
provenance workflows are installed as manual dispatch surfaces while hosted CI
is out of budget. The Release Please workflow does not dispatch publication
until the npm trusted publisher exists. Releases are locally verified and
published until
[Bearing issue #12](https://github.com/kontourai/bearing/issues/12) enables the
automatic triggers and npm trusted publisher.

## License

Apache-2.0.
