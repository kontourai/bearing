# Reference

The public surface of `@kontourai/bearing`: the `bearing` command, the package
entry points, the HTTP read API, rank requests and their limits, and error codes. The
[README](../README.md) explains the behaviour behind each surface, and
[CONTEXT.md](../CONTEXT.md) defines its vocabulary.

## CLI

```text
bearing serve --catalog <file> [--host <host>] [--port <port>]
  [--max-concurrent-rank-requests <count>] [--max-rank-response-bytes <bytes>]
bearing --help
```

`serve` reads a catalog snapshot file, validates it, and serves it over the
[HTTP API](#http-api). It prints the bound URL and stops on `SIGINT` or
`SIGTERM`.

| Option | Default | Meaning |
| --- | --- | --- |
| `--catalog <file>` | required | A serialized catalog snapshot, for example one written with `serializeCatalog`. |
| `--host <host>` | `127.0.0.1` | Interface to bind. |
| `--port <port>` | `4244` | Port from 0 through 65535. `0` picks a free port. |
| `--max-concurrent-rank-requests <count>` | `4` | Positive integer. Further rank requests get `503`. |
| `--max-rank-response-bytes <bytes>` | `8388608` (8 MiB) | Positive integer. Larger rank results get `422`. |

With no arguments, `--help` or `-h` prints usage. A usage error exits `2`. A
runtime failure, such as an invalid catalog file or a port in use, prints
`bearing: <message>` and exits `1`.

The CLI reads only the options listed above. It ignores any other flag or
argument without an error, so a misspelled option is not reported and its
default applies.

## Package entry points

`@kontourai/bearing` is the offline core. It performs no file or network
access.

| Export | Purpose |
| --- | --- |
| `compileCatalog(observations, { asOf })` | Validate observations and compile a deterministic, content-addressed `CatalogSnapshot`. |
| `normalizeObservation(observation)` | Validate one observation and compute its id. |
| `validateObservation`, `validateModelIdentity`, `validateExecutionProfile`, `validateExecutionScope` | Structural validators. |
| `parseCatalog(text)`, `serializeCatalog(snapshot)`, `validateCatalogSnapshot(value)` | Read, write, and verify a snapshot. Validation recompiles the snapshot and requires an exact match. |
| `rankCatalog(snapshot, request)` | Rank a caller-supplied inventory against a snapshot. |
| `createCatalogRanker(snapshot)` | Validate and index one snapshot once, then rank repeatedly. |
| `validateRankRequest(request)` | Validate and normalize a v1 or v2 rank request. |
| `createCatalogHandler({ catalog, maxConcurrentRankRequests?, maxRankResponseBytes? })` | A Web-standard `Request -> Response` handler that serves the [HTTP API](#http-api). |
| `importAiderPolyglotSnapshot`, `importKontourEvalsResults`, `importLiveBenchSnapshots`, `importOpenRouterModelsSnapshot` | Trusted-source adapters. See [Trusted Source Ingestion](../README.md#trusted-source-ingestion). |
| `parseApprovedSourceManifest`, `DEFAULT_APPROVED_SOURCE_REGISTRY`, `discoverLiveBenchBundle`, `resolveLiveBenchDiscovery` | Approved-source manifest and discovery. See [Trusted source discovery](../README.md#trusted-source-discovery). |
| `canonicalJson`, `sha256`, `compareText` | The canonical serialization and hashing used for ids and digests. |
| `BearingError` | The error type thrown by validation, compilation, and ranking. |

The package also exports the schema-version constants
(`OBSERVATION_SCHEMA_VERSION`, `CATALOG_SCHEMA_VERSION`, and the rank request
and result versions), the [rank limits](#rank-request-limits), and the
TypeScript types for every input and result.

`@kontourai/bearing/node` adds Node helpers:

| Export | Purpose |
| --- | --- |
| `readCatalogFile(file)` | Read and validate a catalog snapshot file. |
| `startCatalogServer({ catalog, host?, port?, maxConcurrentRankRequests?, maxRankResponseBytes? })` | Start a local HTTP server around `createCatalogHandler`. Resolves to `{ url, close() }`. |
| `readApprovedSourceManifest(file)` | Read and parse an approved source manifest. |
| `loadPackagedApprovedSourceManifest()` | Load the manifest shipped in `sources/approved-sources.v1.json`. |

## HTTP API

The handler serves one validated, immutable snapshot. Every path is under
`/v1`. If the first path segment is anything else that starts with `v`, the
response is `404 UNSUPPORTED_API_VERSION`. That includes `/v2` and also
non-version paths such as `/validate`. Any other unknown path returns
`404 NOT_FOUND`.

| Method | Path | Response `schemaVersion` | Returns |
| --- | --- | --- | --- |
| `GET`, `HEAD` | `/v1/models` | `bearing.api.models/v1` | Each model's `key`, `identity`, `observationCount`, and `conflictCount`. |
| `GET`, `HEAD` | `/v1/models/<key>` | `bearing.api.model/v1` | One model with all retained observations and evidence, plus its conflict sets. |
| `GET`, `HEAD` | `/v1/catalog/snapshot` | `bearing.catalog/v2` | The complete snapshot. |
| `POST` | `/v1/rank` | `bearing.rank.result/v1` or `/v2` | A rank result. The request's `schemaVersion` selects the result version. |
| `OPTIONS` | `/v1/rank` | none | CORS preflight, `204`. |

`<key>` is the opaque `key` that `/v1/models` returns for each model, not the
model `id`. It is a content hash of the model identity, so look it up from
`/v1/models` first.

Every response from the handler carries these headers, including `304`
responses and error responses:

- `ETag: "bearing-<digest>"`
- `X-Bearing-Catalog-Digest` and `X-Bearing-Catalog-As-Of`
- `Access-Control-Allow-Origin: *`
- `Access-Control-Expose-Headers: ETag, X-Bearing-Catalog-As-Of, X-Bearing-Catalog-Digest`,
  so browser clients can read those three headers
- `Cache-Control: public, max-age=0, must-revalidate`

The `GET` and `HEAD` endpoints honour `If-None-Match`. When it matches the
snapshot's `ETag` (or is `*`), both `GET` and `HEAD` answer `304 Not Modified`
with no body.

Errors use one body shape:

```json
{
  "schemaVersion": "bearing.api.error/v1",
  "error": { "code": "MODEL_NOT_FOUND", "message": "..." },
  "catalog": { "digest": "...", "asOf": "..." }
}
```

| Status | `error.code` | Cause |
| --- | --- | --- |
| `400` | `INVALID_RANK_REQUEST` | The rank body is not JSON or fails validation. The message names the offending path. |
| `404` | `NOT_FOUND`, `MODEL_NOT_FOUND`, `UNSUPPORTED_API_VERSION` | Unknown path, model key, or API version. |
| `405` | `METHOD_NOT_ALLOWED` | Wrong method. The `Allow` header lists the accepted ones. |
| `413` | `PAYLOAD_TOO_LARGE` | The rank body exceeds 1 MiB (`MAX_RANK_REQUEST_BYTES`). |
| `422` | `RANK_RESULT_TOO_LARGE` | The serialized rank result exceeds the response budget. |
| `503` | `RANK_CAPACITY_EXCEEDED` | Too many concurrent rank requests. The response sets `Retry-After: 1`. |

The Node server (`bearing serve` and `startCatalogServer`) answers an
unexpected handler failure with `500 INTERNAL_ERROR`. That response comes from
the server, not the handler. It carries only a `Content-Type` header, none of
the catalog, cache, or CORS headers above, and its body has no `catalog` field.

Bearing has no authentication or per-caller rate limiting. Put those at your
ingress.

## Rank requests

`rankCatalog`, `createCatalogRanker`, and `POST /v1/rank` accept two message
versions. The request's `schemaVersion` selects the result version:
`bearing.rank.request/v1` returns `bearing.rank.result/v1`, and
`bearing.rank.request/v2` returns `bearing.rank.result/v2`. Unknown keys are
refused at every level. String fields must be non-empty and have no leading or
trailing whitespace.

```json
{
  "schemaVersion": "bearing.rank.request/v2",
  "task": { "family": "software-engineering", "suite": null },
  "inventory": [],
  "requirements": [],
  "preferences": [],
  "advisories": []
}
```

| Field | Required | Shape |
| --- | --- | --- |
| `schemaVersion` | yes | `bearing.rank.request/v1` or `bearing.rank.request/v2`. |
| `task` | yes | `{ family, suite }`. `family` is a string. `suite` is a string or `null`. |
| `inventory` | yes, may be empty | Runtime candidates `{ id, model, execution }`. Ids must be unique. |
| `requirements` | yes, may be empty | `{ measurementKey, aggregation, operator, value, sourceClasses? }`. |
| `preferences` | yes, may be empty | `{ measurementKey, aggregation, direction, weight, sourceClasses? }`. |
| `advisories` | v2 only, yes, may be empty | `{ id, measurementKey, aggregation, sourceClasses? }`. Ids must be unique. A v1 request that includes `advisories` is refused. |

The nested fields:

- `model` is `{ id, revision, quantization }`. `revision` and `quantization`
  are strings or `null`.
- `execution` must be a concrete execution profile, not `null`. It needs every
  one of `runtime`, `adapter`, `effectiveContextTokens`, `toolSurface`,
  `hardware`, and `workflow`:
  - `runtime` is `{ id, version }`.
  - `adapter` is `{ id, version }` or `null`.
  - `effectiveContextTokens` is an integer or `null`.
  - `toolSurface` is an array of strings.
  - `hardware` is `{ class, accelerator, memoryBytes }` or `null`.
  - `workflow` is `{ id, version, condition }` or `null`.
- `aggregation` is `fact`, `mean`, `min`, `max`, `success-rate`, or `count`.
- `operator` is `eq`, `gte`, or `lte`. `value` is a string, number, or boolean,
  and must be a number for `gte` and `lte`.
- `direction` is `maximize` or `minimize`. `weight` is a positive finite
  number.
- `sourceClasses`, when present, is a non-empty list of `first-party` and
  `external`, with no duplicates.
- Duplicate requirements or preferences are refused.

## Rank request limits

Validation applies these bounds before any evaluation, to v1 and v2 requests
alike.

| Constant | Value | Bound |
| --- | --- | --- |
| `MAX_RANK_CANDIDATES` | 128 | Candidates in `inventory`. |
| `MAX_RANK_CRITERIA` | 128 | Entries in `requirements`, and separately in `preferences`. |
| `MAX_RANK_CRITERION_CELLS` | 2048 | Candidates multiplied by requirements plus preferences. |
| `MAX_RANK_TEXT_BYTES` | 256 | UTF-8 bytes in each bounded text field. |
| `MAX_RANK_V2_ADVISORIES` | 64 | Entries in a v2 `advisories` list. |
| `MAX_RANK_V2_ADVISORY_CELLS` | 1024 | Candidates multiplied by advisories. |

## Errors

Library functions throw `BearingError`. Its `code` identifies the failure and
its `path` is a JSON path such as `$.inventory[0].model`; the message begins
with that path.

| Code | Thrown when |
| --- | --- |
| `INVALID_OBSERVATION` | An observation fails structural validation. |
| `UNSUPPORTED_SCHEMA` | An observation's `schemaVersion` is not `bearing.observation/v2`. |
| `DUPLICATE_OBSERVATION` | Two inputs normalize to the same observation id. |
| `INVALID_COMPILE_OPTIONS` | `asOf` is not a valid timestamp, or an observation or its evidence is dated after it. |
| `INVALID_CATALOG` | A snapshot is not valid JSON, is malformed, or does not match its recompiled content. |
| `UNSUPPORTED_CATALOG_SCHEMA` | A snapshot's `schemaVersion` is not `bearing.catalog/v2`. Catalog v1 cannot be reinterpreted; recompile from observation v2. |
| `INVALID_RANK_REQUEST` | A rank request fails validation or exceeds a [limit](#rank-request-limits). |
| `INVALID_SOURCE_SNAPSHOT` | A trusted-source adapter refuses its input, for example a snapshot reference that does not bind the supplied bytes. |
| `INVALID_SOURCE_MANIFEST` | An approved source manifest fails validation. |
| `INVALID_SOURCE_DISCOVERY` | LiveBench source discovery refuses its input. |
