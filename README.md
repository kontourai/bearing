# @kontourai/bearing

Evidence-backed model capability intelligence. Bearing accepts provenance-bearing
model observations, compiles them into deterministic catalog snapshots, and
supports runtime-aware ranking without invoking models.

Bearing answers **what current evidence says a model can do**. It does not own
provider credentials, discover a caller's launchable models, or make model calls.
Datum combines Bearing snapshots with local configuration and runtime inventory;
Station and other runtimes consume that resolution.

## Status

The initial catalog contract is under development. See
[Bearing issue #1](https://github.com/kontourai/bearing/issues/1) for the product
delivery graph.

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

## Development

```sh
npm install
npm run verify
```

Node.js 22 or newer is required. Bearing has no runtime dependencies.

## License

Apache-2.0.
