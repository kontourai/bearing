import assert from "node:assert/strict";
import test from "node:test";

import {
  BearingError,
  compileCatalog,
  createCatalogHandler,
  rankCatalog,
  type ExecutionProfile,
  type ModelIdentity,
  type ObservationInput,
  type RankRequest,
} from "../src/index.js";
import { startCatalogServer } from "../src/node/index.js";

const execution: ExecutionProfile = {
  runtime: { id: "local-runtime", version: "1.0.0" },
  adapter: { id: "agent-adapter", version: "4.2.0" },
  effectiveContextTokens: 32_768,
  toolSurface: ["edit", "shell"],
  hardware: { class: "desktop-gpu", accelerator: "gpu", memoryBytes: 24_000_000_000 },
  workflow: { id: "builder", version: "4.2.0", condition: "kit" },
};

const modelA: ModelIdentity = { id: "example/model-a", revision: "r1", quantization: "q8" };
const modelB: ModelIdentity = { id: "example/model-b", revision: "r1", quantization: "q8" };

const evidence = (id: string, observedAt = "2026-07-18T20:00:00.000Z") => [{
  id,
  kind: "eval-result",
  uri: `artifact://evals/${id}.json`,
  digest: null,
  observedAt,
}];

const fact = (
  model: ModelIdentity,
  key: string,
  value: string | number | boolean,
  id: string,
  scopedExecution: ExecutionProfile | null = null,
  validUntil: string | null = null,
): ObservationInput => ({
  schemaVersion: "bearing.observation/v1",
  kind: "declaration",
  model,
  execution: scopedExecution,
  task: null,
  measurements: [{ key, kind: "fact", value }],
  outcome: null,
  usage: null,
  sourceClass: "external",
  evidence: evidence(id),
  freshness: { observedAt: "2026-07-18T20:00:00.000Z", validUntil },
  uncertainty: { level: "moderate", basis: ["published specification"], gaps: [] },
});

const sample = (
  model: ModelIdentity,
  accepted: boolean,
  tokens: number,
  id: string,
): ObservationInput => ({
  schemaVersion: "bearing.observation/v1",
  kind: "evaluation",
  model,
  execution,
  task: {
    family: "software-engineering",
    suite: "example-suite",
    taskId: id,
    evaluator: { id: "example-grader", version: "v1" },
  },
  measurements: [
    { key: "task.accepted", kind: "sample", value: accepted },
    { key: "usage.total_tokens", kind: "sample", value: tokens, unit: "tokens" },
  ],
  outcome: { status: accepted ? "accepted" : "rejected", reason: accepted ? null : "tests failed" },
  usage: {
    inputTokens: tokens - 100,
    outputTokens: 100,
    reasoningTokens: null,
    totalTokens: tokens,
    completeness: "complete",
    modelCalls: 1,
    wallTimeMs: 1000,
  },
  sourceClass: "first-party",
  evidence: evidence(id),
  freshness: { observedAt: "2026-07-18T20:00:00.000Z", validUntil: null },
  uncertainty: { level: "low", basis: ["independent grader"], gaps: [] },
});

const observations = (): ObservationInput[] => [
  fact(modelA, "model.context.max_tokens", 32_768, "a-context"),
  fact(modelA, "tool.shell.supported", true, "a-shell", execution),
  sample(modelA, true, 1000, "a-pass"),
  sample(modelA, false, 1000, "a-fail"),
  fact(modelB, "model.context.max_tokens", 131_072, "b-context"),
  fact(modelB, "tool.shell.supported", true, "b-shell", execution),
  sample(modelB, true, 3000, "b-pass-1"),
  sample(modelB, true, 3000, "b-pass-2"),
];

const inventory = [
  { id: "runtime:model-a", model: modelA, execution },
  { id: "runtime:model-b", model: modelB, execution },
];

const request = (overrides: Partial<RankRequest> = {}): RankRequest => ({
  schemaVersion: "bearing.rank.request/v1",
  task: { family: "software-engineering", suite: null },
  inventory,
  requirements: [
    { measurementKey: "model.context.max_tokens", aggregation: "fact", operator: "gte", value: 32_768 },
    { measurementKey: "tool.shell.supported", aggregation: "fact", operator: "eq", value: true },
  ],
  preferences: [
    { measurementKey: "task.accepted", aggregation: "success-rate", direction: "maximize", weight: 2 },
    { measurementKey: "usage.total_tokens", aggregation: "mean", direction: "minimize", weight: 1 },
  ],
  ...overrides,
});

test("hard requirements filter before request-relative preference ranking", () => {
  const catalog = compileCatalog(observations(), { asOf: "2026-07-18T22:00:00.000Z" });
  const result = rankCatalog(catalog, request());

  assert.deepEqual(result.ranked.map((candidate) => candidate.candidateId), ["runtime:model-b", "runtime:model-a"]);
  assert.equal(result.excluded.length, 0);
  assert.equal(result.ranked[0].rank, 1);
  assert.equal(result.ranked[0].score, 2);
  assert.equal(result.ranked[1].score, 1);
  assert.deepEqual(result.scoreScale, { kind: "request-relative", maximum: 3 });
  assert.equal(result.catalog.digest, catalog.digest);
  assert.ok(result.ranked[0].evidence.some((item) => item.observationIds.length > 0));
});

test("ranking never adds a model absent from runtime inventory", () => {
  const catalog = compileCatalog(observations(), { asOf: "2026-07-18T22:00:00.000Z" });
  const result = rankCatalog(catalog, request({ inventory: [inventory[0]] }));
  assert.deepEqual(result.ranked.map((candidate) => candidate.candidateId), ["runtime:model-a"]);
  assert.equal(result.ranked.some((candidate) => candidate.model.id === modelB.id), false);
});

test("count aggregation can enforce minimum sample volume", () => {
  const catalog = compileCatalog(observations(), { asOf: "2026-07-18T22:00:00.000Z" });
  const result = rankCatalog(catalog, request({
    requirements: [{ measurementKey: "task.accepted", aggregation: "count", operator: "gte", value: 3 }],
    preferences: [],
  }));
  assert.equal(result.ranked.length, 0);
  assert.ok(result.excluded.every((candidate) => candidate.reasons.some((reason) => reason.code === "REQUIREMENT_NOT_MET")));
});

test("invalid evaluation measurements never contribute to ranking", () => {
  const invalid: ObservationInput = {
    ...sample(modelA, true, 1000, "invalid-pass"),
    outcome: { status: "invalid", reason: "runner did not execute" },
  };
  const catalog = compileCatalog([...observations(), invalid], { asOf: "2026-07-18T22:00:00.000Z" });
  const result = rankCatalog(catalog, request({
    inventory: [inventory[0]],
    requirements: [{ measurementKey: "task.accepted", aggregation: "count", operator: "gte", value: 3 }],
    preferences: [],
  }));
  assert.equal(result.ranked.length, 0);
  assert.equal(result.excluded[0].reasons.some((reason) => reason.code === "REQUIREMENT_NOT_MET"), true);
});

test("criteria can separate first-party measurements from external priors", () => {
  const externalSample: ObservationInput = {
    ...sample(modelA, true, 1000, "external-pass"),
    sourceClass: "external",
  };
  const catalog = compileCatalog([...observations(), externalSample], { asOf: "2026-07-18T22:00:00.000Z" });
  const result = rankCatalog(catalog, request({
    inventory: [inventory[0]],
    requirements: [],
    preferences: [{
      measurementKey: "task.accepted",
      aggregation: "success-rate",
      direction: "maximize",
      weight: 1,
      sourceClasses: ["first-party"],
    }],
  }));
  const scoreReason = result.ranked[0].reasons.find((reason) => reason.code === "PREFERENCE_SCORE");
  assert.equal(scoreReason?.actual, 0.5);
  assert.equal(result.ranked[0].evidence[0].observationIds.length, 2);
});

test("runtime tool ordering is normalized before exact profile matching", () => {
  const catalog = compileCatalog(observations(), { asOf: "2026-07-18T22:00:00.000Z" });
  const reversedTools = { ...inventory[0], execution: { ...execution, toolSurface: ["shell", "edit"] } };
  const result = rankCatalog(catalog, request({ inventory: [reversedTools] }));
  assert.equal(result.ranked.length, 1);
});

test("missing, stale, and conflicting requirement evidence exclude explicitly", () => {
  const stale = fact(modelA, "tool.edit.supported", true, "stale-edit", execution, "2026-07-18T21:00:00.000Z");
  const conflict = fact(modelB, "model.context.max_tokens", 16_384, "b-context-conflict");
  const catalog = compileCatalog([...observations(), stale, conflict], { asOf: "2026-07-18T22:00:00.000Z" });
  const result = rankCatalog(catalog, request({
    requirements: [
      { measurementKey: "tool.edit.supported", aggregation: "fact", operator: "eq", value: true },
      { measurementKey: "model.context.max_tokens", aggregation: "fact", operator: "gte", value: 32_768 },
    ],
  }));

  assert.equal(result.ranked.length, 0);
  assert.deepEqual(result.excluded.map((candidate) => candidate.candidateId), ["runtime:model-a", "runtime:model-b"]);
  assert.ok(result.excluded[0].reasons.some((reason) => reason.code === "STALE_EVIDENCE"));
  assert.ok(result.excluded[1].reasons.some((reason) => reason.code === "MISSING_EVIDENCE"));
  assert.ok(result.excluded[1].reasons.some((reason) => reason.code === "CONFLICTING_EVIDENCE"));
});

test("rank results are deterministic across observation and inventory ordering", () => {
  const a = compileCatalog(observations(), { asOf: "2026-07-18T22:00:00.000Z" });
  const b = compileCatalog([...observations()].reverse(), { asOf: "2026-07-18T22:00:00.000Z" });
  assert.deepEqual(rankCatalog(a, request()), rankCatalog(b, request({ inventory: [...inventory].reverse() })));
});

test("invalid rank requests fail with typed diagnostics", () => {
  const catalog = compileCatalog(observations(), { asOf: "2026-07-18T22:00:00.000Z" });
  assert.throws(
    () => rankCatalog(catalog, { ...request(), inventory: [] }),
    (error: unknown) => error instanceof BearingError && error.code === "INVALID_RANK_REQUEST",
  );
});

test("POST /v1/rank exposes the same deterministic operation", async () => {
  const catalog = compileCatalog(observations(), { asOf: "2026-07-18T22:00:00.000Z" });
  const handler = createCatalogHandler({ catalog });
  const response = await handler(new Request("https://bearing.example/v1/rank", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request()),
  }));
  assert.equal(response.status, 200);
  const result = await response.json() as { ranked: Array<{ candidateId: string }> };
  assert.equal(result.ranked[0].candidateId, "runtime:model-b");

  const malformed = await handler(new Request("https://bearing.example/v1/rank", {
    method: "POST",
    body: "not json",
  }));
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json() as { error: { code: string } }).error.code, "INVALID_RANK_REQUEST");

  const preflight = await handler(new Request("https://bearing.example/v1/rank", { method: "OPTIONS" }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-methods"), "POST, OPTIONS");

  const tooLarge = await handler(new Request("https://bearing.example/v1/rank", {
    method: "POST",
    headers: { "content-length": "1048577" },
    body: "{}",
  }));
  assert.equal(tooLarge.status, 413);
});

test("the Node adapter carries rank request bodies into the same handler", async () => {
  const catalog = compileCatalog(observations(), { asOf: "2026-07-18T22:00:00.000Z" });
  const server = await startCatalogServer({ catalog, host: "127.0.0.1", port: 0 });
  try {
    const response = await fetch(`${server.url}/v1/rank`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request()),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { ranked: Array<{ candidateId: string }> }).ranked[0].candidateId, "runtime:model-b");
  } finally {
    await server.close();
  }
});
