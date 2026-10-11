# Getting Started

This guide takes one observation from input to a served catalog. For the
vocabulary used here, see [CONTEXT.md](../CONTEXT.md). For every option and
endpoint, see the [reference](reference.md).

## Install

Bearing is published as `@kontourai/bearing` and requires Node.js 22 or newer.
It is an ES module package.

```sh
npm install @kontourai/bearing
```

The package has two entry points:

- `@kontourai/bearing`: validation, catalog compilation, ranking, the
  Web-standard request handler, and the trusted-source adapters. None of them
  read files or touch the network.
- `@kontourai/bearing/node`: Node helpers that read a catalog or an approved
  source manifest from disk and start a local HTTP server.

It also installs a `bearing` command that serves a catalog file.

## Compile a catalog

A catalog starts from Capability Observations. Each one carries an explicit
model identity, measurements, evidence, freshness, and uncertainty.
`compileCatalog` validates them and produces a content-addressed snapshot as of
a time you supply. Identical inputs and `asOf` produce an identical snapshot and
digest.

```js
import { writeFileSync } from "node:fs";
import { compileCatalog, serializeCatalog } from "@kontourai/bearing";

const observation = {
  schemaVersion: "bearing.observation/v2",
  kind: "declaration",
  model: { id: "example/model-a", revision: "r1", quantization: "q8" },
  execution: null,
  task: null,
  measurements: [{ key: "model.context.max_tokens", kind: "fact", value: 32768 }],
  outcome: null,
  usage: null,
  sourceClass: "external",
  evidence: [{
    id: "example-context",
    kind: "model-card",
    uri: null,
    digest: null,
    observedAt: "2026-07-18T20:00:00.000Z",
  }],
  freshness: { observedAt: "2026-07-18T20:00:00.000Z", validUntil: null },
  uncertainty: { level: "moderate", basis: ["published specification"], gaps: [] },
};

const snapshot = compileCatalog([observation], { asOf: "2026-07-18T22:00:00.000Z" });
writeFileSync("catalog.json", serializeCatalog(snapshot));
```

`compileCatalog` throws a `BearingError` when an observation is invalid, when an
observation or its evidence is dated after `asOf`, or when two inputs normalize
to the same observation. See [Errors](reference.md#errors).

## Serve it

```sh
npx bearing serve --catalog ./catalog.json
```

The server binds `127.0.0.1:4244` by default and prints its URL. Reading the
file validates the snapshot by recompiling it, so a hand-edited catalog is
refused at startup.

```sh
curl http://127.0.0.1:4244/v1/models
curl http://127.0.0.1:4244/v1/catalog/snapshot
```

Every response carries the snapshot digest in its `ETag` and in the
`X-Bearing-Catalog-Digest` header, so a client can cache the catalog and work
offline.

## Rank your own candidates

Bearing ranks only the runtime candidates you send it. Call `rankCatalog` in
process, or `POST /v1/rank` on the server, with your inventory, hard
requirements, and weighted preferences. The [Usage](../README.md#usage) example
in the README shows a complete request, and
[Runtime-Aware Ranking](../README.md#runtime-aware-ranking) explains how
requirements, preferences, and advisories are evaluated.

To rank many requests against one snapshot, prepare a ranker once:

```js
import { createCatalogRanker } from "@kontourai/bearing";

const rank = createCatalogRanker(snapshot);
const result = rank(request);
```

## Next steps

- [Reference](reference.md): the CLI, HTTP endpoints, limits, and error codes.
- [Trusted Source Ingestion](../README.md#trusted-source-ingestion): importing
  observations from Aider Polyglot, Kontour Evals, LiveBench, and OpenRouter.
- [Catalog Contract](decisions/catalog-contract.md) and
  [Runtime-Aware Ranking](decisions/ranking.md): the design decisions behind
  these behaviours.
