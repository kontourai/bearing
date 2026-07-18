import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BearingError,
  compileCatalog,
  createCatalogHandler,
  parseCatalog,
  serializeCatalog,
  sha256,
  validateCatalogSnapshot,
  type ObservationInput,
} from "../src/index.js";
import { readCatalogFile, startCatalogServer } from "../src/node/index.js";

const observation = (): ObservationInput => ({
  schemaVersion: "bearing.observation/v1",
  kind: "declaration",
  model: { id: "example/model-7b", revision: "r1", quantization: null },
  execution: null,
  task: null,
  measurements: [{ key: "model.context.max_tokens", kind: "fact", value: 32_768, unit: "tokens" }],
  outcome: null,
  usage: null,
  sourceClass: "external",
  evidence: [{
    id: "model-card",
    kind: "model-card",
    uri: "https://example.test/model-card",
    digest: null,
    observedAt: "2026-07-18T20:00:00.000Z",
  }],
  freshness: { observedAt: "2026-07-18T20:00:00.000Z", validUntil: null },
  uncertainty: { level: "moderate", basis: ["publisher declaration"], gaps: [] },
});

const catalog = () => compileCatalog([observation()], { asOf: "2026-07-18T22:00:00.000Z" });

test("catalog serialization validates digest and canonical shape", () => {
  const expected = catalog();
  assert.deepEqual(parseCatalog(serializeCatalog(expected)), expected);
  assert.deepEqual(validateCatalogSnapshot(expected), expected);

  assert.throws(
    () => validateCatalogSnapshot({ ...expected, digest: "0".repeat(64) }),
    (error: unknown) => error instanceof BearingError && error.code === "INVALID_CATALOG",
  );
  const wrongGroupingContent = {
    ...expected,
    models: [{ ...expected.models[0], identity: { ...expected.models[0].identity, revision: "wrong" } }],
  };
  const { digest: _ignored, ...wrongGroupingWithoutDigest } = wrongGroupingContent;
  assert.throws(
    () => validateCatalogSnapshot({ ...wrongGroupingContent, digest: sha256(wrongGroupingWithoutDigest) }),
    (error: unknown) => error instanceof BearingError && error.code === "INVALID_CATALOG",
  );
  assert.throws(
    () => parseCatalog("not json"),
    (error: unknown) => error instanceof BearingError && error.code === "INVALID_CATALOG",
  );
});

test("read API lists models and returns evidence-bearing model detail", async () => {
  const expected = catalog();
  const handler = createCatalogHandler({ catalog: expected });

  const list = await handler(new Request("https://bearing.example/v1/models"));
  assert.equal(list.status, 200);
  assert.equal(list.headers.get("etag"), `"bearing-${expected.digest}"`);
  assert.equal(list.headers.get("x-bearing-catalog-digest"), expected.digest);
  assert.equal(list.headers.get("access-control-allow-origin"), "*");
  const listBody = await list.json() as { models: Array<{ key: string; observationCount: number }> };
  assert.deepEqual(listBody.models, [{
    key: expected.models[0].key,
    identity: expected.models[0].identity,
    observationCount: 1,
    conflictCount: 0,
  }]);

  const detail = await handler(new Request(`https://bearing.example/v1/models/${expected.models[0].key}`));
  assert.equal(detail.status, 200);
  const detailBody = await detail.json() as { model: typeof expected.models[0] };
  assert.deepEqual(detailBody.model, expected.models[0]);
  assert.equal(detailBody.model.observations[0].evidence[0].id, "model-card");
});

test("snapshot reads are canonical and support conditional requests", async () => {
  const expected = catalog();
  const handler = createCatalogHandler({ catalog: expected });
  const first = await handler(new Request("https://bearing.example/v1/catalog/snapshot"));
  assert.equal(first.status, 200);
  assert.equal(await first.text(), serializeCatalog(expected));

  const conditional = await handler(new Request("https://bearing.example/v1/catalog/snapshot", {
    headers: { "if-none-match": first.headers.get("etag")! },
  }));
  assert.equal(conditional.status, 304);
  assert.equal(await conditional.text(), "");
});

test("API errors are versioned and deterministic", async () => {
  const handler = createCatalogHandler({ catalog: catalog() });
  const unknownModel = await handler(new Request(`https://bearing.example/v1/models/${"f".repeat(64)}`));
  assert.equal(unknownModel.status, 404);
  assert.equal((await unknownModel.json() as { error: { code: string } }).error.code, "MODEL_NOT_FOUND");

  const wrongVersion = await handler(new Request("https://bearing.example/v2/models"));
  assert.equal(wrongVersion.status, 404);
  assert.equal((await wrongVersion.json() as { error: { code: string } }).error.code, "UNSUPPORTED_API_VERSION");

  const method = await handler(new Request("https://bearing.example/v1/models", { method: "POST" }));
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("allow"), "GET, HEAD");

  const unknownWithMatchingEtag = await handler(new Request("https://bearing.example/v1/missing", {
    headers: { "if-none-match": `"bearing-${catalog().digest}"` },
  }));
  assert.equal(unknownWithMatchingEtag.status, 404);
});

test("offline catalog files and the thin Node server use the same contract", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bearing-api-"));
  const file = path.join(root, "catalog.json");
  const expected = catalog();
  await writeFile(file, serializeCatalog(expected), "utf8");
  try {
    assert.deepEqual(await readCatalogFile(file), expected);
    const server = await startCatalogServer({ catalog: expected, host: "127.0.0.1", port: 0 });
    try {
      const response = await fetch(`${server.url}/v1/catalog/snapshot`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), expected);
    } finally {
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
