# Read API

Status: accepted for the initial Bearing read surface.

## Decision

Bearing's API core is a Web-standard `Request -> Response` handler over one
already-validated immutable Catalog Snapshot. A thin Node adapter translates
HTTP requests into that handler for local use. Hosted adapters may bind the same
handler to Cloudflare Workers or another Fetch-compatible platform.

The API never reads observations, provider credentials, or model runtimes. It
serves a snapshot selected by its host. Every response identifies the active
snapshot digest and `asOf`; `ETag` and conditional reads use that digest. Datum
can download the snapshot and continue operating offline.

Snapshot validation deterministically recompiles the enclosed observations and
compares the entire canonical result. A supplied digest alone is insufficient:
model grouping, observation ids, conflict sets, ordering, and digest must all
match compiler output.

## Consequences

- Local and hosted APIs share behavior and tests.
- A host can atomically change the active snapshot without changing API logic.
- Any catalog change invalidates model-detail caches, even when an unrelated
  model changed. This is conservative and preserves one simple snapshot ETag.
- Ingestion and publication authority remain outside this read-only slice.
