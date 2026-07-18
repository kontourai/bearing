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
bearing serve --catalog ./catalog.json --host 127.0.0.1 --port 4244
curl http://127.0.0.1:4244/v1/models
curl http://127.0.0.1:4244/v1/catalog/snapshot
```

The API supports `GET`, `HEAD`, `ETag`, and `If-None-Match`. Model list entries
carry a stable model key; `GET /v1/models/<key>` returns the complete retained
observations, evidence references, and conflict sets for that identity.

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

## Development

```sh
npm install
npm run verify
```

Node.js 22 or newer is required. Bearing has no runtime dependencies.

## Releases

Package contents are checked by `npm run verify`. Release Please and npm
provenance workflows are installed as manual dispatch surfaces while hosted CI
is out of budget. Releases are locally verified and published until
[Bearing issue #12](https://github.com/kontourai/bearing/issues/12) enables the
automatic triggers and npm trusted publisher.

## License

Apache-2.0.
