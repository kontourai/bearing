import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";

import {
  BearingError,
  canonicalJson,
  compileCatalog,
  createCatalogHandler,
  rankCatalog,
  type ExecutionProfile,
  type CatalogRanker,
  type ModelIdentity,
  type ObservationInput,
  type RankRequest,
  type RankRequestV2,
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
  schemaVersion: "bearing.observation/v2",
  kind: "declaration",
  model,
  execution: scopedExecution === null ? null : { kind: "exact", ...scopedExecution },
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
  schemaVersion: "bearing.observation/v2",
  kind: "evaluation",
  model,
  execution: { kind: "exact", ...execution },
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

const requestV2 = (overrides: Partial<Omit<RankRequestV2, "schemaVersion">> = {}): RankRequestV2 => {
  const { schemaVersion: _schemaVersion, ...base } = request();
  return {
    schemaVersion: "bearing.rank.request/v2",
    ...base,
    advisories: [],
    ...overrides,
  };
};

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

test("partial declarations match asserted runtime dimensions and explain wildcarded fields", () => {
  const partial: ObservationInput = {
    ...fact(modelA, "openrouter.model.context.max_tokens", 1_050_000, "openrouter-context"),
    execution: {
      kind: "partial",
      runtime: { id: "openrouter", version: null },
      adapter: null,
      effectiveContextTokens: null,
      toolSurface: null,
      hardware: null,
      workflow: null,
    },
  };
  const catalog = compileCatalog([partial], { asOf: "2026-07-18T22:00:00.000Z" });
  const openrouter = {
    id: "openrouter:model-a",
    model: modelA,
    execution: {
      ...execution,
      runtime: { id: "openrouter", version: "2026-07-18" },
      adapter: { id: "caller-openrouter-adapter", version: "9.0.0" },
      toolSurface: ["browser", "shell"],
    },
  };
  const local = { id: "local:model-a", model: modelA, execution };
  const result = rankCatalog(catalog, request({
    inventory: [local, openrouter],
    requirements: [{
      measurementKey: "openrouter.model.context.max_tokens",
      aggregation: "fact",
      operator: "gte",
      value: 1_000_000,
    }],
    preferences: [],
  }));

  assert.deepEqual(result.ranked.map((candidate) => candidate.candidateId), ["openrouter:model-a"]);
  const matched = result.ranked[0].reasons[0].executionApplicability!;
  assert.deepEqual(matched.matchedKinds, ["partial"]);
  assert.deepEqual(matched.assertedDimensions, ["runtime.id"]);
  assert.deepEqual(matched.wildcardedDimensions, [
    "adapter",
    "effectiveContextTokens",
    "hardware",
    "runtime.version",
    "toolSurface",
    "workflow",
  ]);
  const rejected = result.excluded[0].reasons[0];
  assert.equal(rejected.code, "INCOMPARABLE_EVIDENCE");
  assert.deepEqual(rejected.executionApplicability?.mismatchedDimensions, ["runtime.id"]);
  assert.deepEqual(result.excluded[0].evidence[0].evidenceIds, ["openrouter-context"]);
});

test("partial scope nulls are wildcards while empty tools remain known-empty", () => {
  const partial: ObservationInput = {
    ...fact(modelA, "runtime.ready", true, "partial-runtime-ready"),
    execution: {
      kind: "partial",
      runtime: { id: "local-runtime", version: null },
      adapter: { id: "agent-adapter", version: null },
      effectiveContextTokens: 32_768,
      toolSurface: [],
      hardware: { class: "desktop-gpu", accelerator: null, memoryBytes: null },
      workflow: { id: "builder", version: null, condition: "kit" },
    },
  };
  const catalog = compileCatalog([partial], { asOf: "2026-07-18T22:00:00.000Z" });
  const knownEmpty = { ...execution, toolSurface: [] };
  const matching = rankCatalog(catalog, request({
    inventory: [{ id: "empty-tools", model: modelA, execution: knownEmpty }],
    requirements: [{ measurementKey: "runtime.ready", aggregation: "fact", operator: "eq", value: true }],
    preferences: [],
  }));
  assert.equal(matching.ranked.length, 1);
  const applicability = matching.ranked[0].reasons[0].executionApplicability!;
  assert.ok(applicability.assertedDimensions.includes("toolSurface"));
  assert.ok(applicability.wildcardedDimensions.includes("hardware.accelerator"));
  assert.ok(applicability.wildcardedDimensions.includes("hardware.memoryBytes"));
  assert.ok(applicability.wildcardedDimensions.includes("workflow.version"));

  const nonEmpty = rankCatalog(catalog, request({
    inventory: [{ id: "non-empty-tools", model: modelA, execution }],
    requirements: [{ measurementKey: "runtime.ready", aggregation: "fact", operator: "eq", value: true }],
    preferences: [],
  }));
  assert.equal(nonEmpty.excluded[0].reasons[0].code, "INCOMPARABLE_EVIDENCE");
  assert.deepEqual(nonEmpty.excluded[0].reasons[0].executionApplicability?.mismatchedDimensions, ["toolSurface"]);

  const mismatches: Array<[string, ExecutionProfile]> = [
    ["adapter.id", { ...knownEmpty, adapter: { id: "other-adapter", version: "4.2.0" } }],
    ["effectiveContextTokens", { ...knownEmpty, effectiveContextTokens: 16_384 }],
    ["hardware.class", { ...knownEmpty, hardware: { ...knownEmpty.hardware!, class: "server-gpu" } }],
    ["workflow.condition", { ...knownEmpty, workflow: { ...knownEmpty.workflow!, condition: "bare" } }],
  ];
  for (const [dimension, candidateExecution] of mismatches) {
    const mismatch = rankCatalog(catalog, request({
      inventory: [{ id: dimension, model: modelA, execution: candidateExecution }],
      requirements: [{ measurementKey: "runtime.ready", aggregation: "fact", operator: "eq", value: true }],
      preferences: [],
    }));
    assert.deepEqual(
      mismatch.excluded[0].reasons[0].executionApplicability?.mismatchedDimensions,
      [dimension],
    );
  }
});

test("partial nested versions and optional hardware fields match only when asserted", () => {
  const partial: ObservationInput = {
    ...fact(modelA, "runtime.ready", true, "partial-versioned-runtime"),
    execution: {
      kind: "partial",
      runtime: { id: "local-runtime", version: "1.2.3" },
      adapter: { id: "agent-adapter", version: "4.2.0" },
      effectiveContextTokens: null,
      toolSurface: null,
      hardware: { class: "desktop-gpu", accelerator: "gpu-1", memoryBytes: 24_000_000_000 },
      workflow: { id: "builder", version: "2.0.0", condition: null },
    },
  };
  const catalog = compileCatalog([partial], { asOf: "2026-07-18T22:00:00.000Z" });
  const requirement = [{ measurementKey: "runtime.ready", aggregation: "fact" as const, operator: "eq" as const, value: true }];
  const matchingExecution: ExecutionProfile = {
    ...execution,
    runtime: { ...execution.runtime, version: "1.2.3" },
    hardware: { ...execution.hardware!, accelerator: "gpu-1" },
    workflow: { ...execution.workflow!, version: "2.0.0" },
  };
  const mismatches: Array<[string, ExecutionProfile]> = [
    ["runtime.version", { ...matchingExecution, runtime: { ...matchingExecution.runtime, version: "1.2.4" } }],
    ["adapter.version", { ...matchingExecution, adapter: { ...matchingExecution.adapter!, version: "4.3.0" } }],
    ["hardware.accelerator", { ...matchingExecution, hardware: { ...matchingExecution.hardware!, accelerator: "gpu-2" } }],
    ["hardware.memoryBytes", { ...matchingExecution, hardware: { ...matchingExecution.hardware!, memoryBytes: 16_000_000_000 } }],
    ["workflow.version", { ...matchingExecution, workflow: { ...matchingExecution.workflow!, version: "2.1.0" } }],
  ];

  for (const [dimension, candidateExecution] of mismatches) {
    const result = rankCatalog(catalog, request({
      inventory: [{ id: dimension, model: modelA, execution: candidateExecution }],
      requirements: requirement,
      preferences: [],
    }));
    assert.deepEqual(
      result.excluded[0].reasons[0].executionApplicability?.mismatchedDimensions,
      [dimension],
    );
  }
});

test("exact evaluation scopes remain exact after partial matching is introduced", () => {
  const catalog = compileCatalog([sample(modelA, true, 1000, "exact-sample")], { asOf: "2026-07-18T22:00:00.000Z" });
  const otherAdapter = { ...execution, adapter: { id: "other-adapter", version: "1.0.0" } };
  const result = rankCatalog(catalog, request({
    inventory: [{ id: "other-adapter", model: modelA, execution: otherAdapter }],
    requirements: [{ measurementKey: "task.accepted", aggregation: "count", operator: "gte", value: 1 }],
    preferences: [],
  }));
  assert.equal(result.ranked.length, 0);
  assert.equal(result.excluded[0].reasons[0].code, "INCOMPARABLE_EVIDENCE");
  assert.deepEqual(result.excluded[0].reasons[0].executionApplicability?.mismatchedDimensions, ["adapter"]);
});

test("advisories expose partial-scope applicability without changing ranking", () => {
  const partial: ObservationInput = {
    ...fact(modelA, "runtime.context", 1_050_000, "advisory-partial"),
    execution: {
      kind: "partial",
      runtime: { id: "openrouter", version: null },
      adapter: null,
      effectiveContextTokens: null,
      toolSurface: null,
      hardware: null,
      workflow: null,
    },
  };
  const catalog = compileCatalog([partial], { asOf: "2026-07-18T22:00:00.000Z" });
  const candidate = {
    id: "openrouter:model-a",
    model: modelA,
    execution: { ...execution, runtime: { id: "openrouter", version: "2026-07-18" } },
  };
  const result = rankCatalog(catalog, requestV2({
    inventory: [candidate],
    requirements: [],
    preferences: [],
    advisories: [{ id: "context", measurementKey: "runtime.context", aggregation: "fact" }],
  }));
  assert.equal(result.ranked[0].advisories[0].status, "present");
  assert.deepEqual(result.ranked[0].advisories[0].executionApplicability.matchedKinds, ["partial"]);
  assert.deepEqual(result.ranked[0].advisories[0].executionApplicability.assertedDimensions, ["runtime.id"]);
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

test("v2 advisories project scalar facts without changing v1 eligibility, scores, or ordering", () => {
  const catalog = compileCatalog([
    ...observations(),
    fact(modelA, "model.license", "Apache-2.0", "a-license"),
    fact(modelB, "model.license", "MIT", "b-license"),
  ], { asOf: "2026-07-18T22:00:00.000Z" });
  const v1 = rankCatalog(catalog, request());
  const v2 = rankCatalog(catalog, requestV2({
    advisories: [
      { id: "license", measurementKey: "model.license", aggregation: "fact" },
      { id: "context", measurementKey: "model.context.max_tokens", aggregation: "fact" },
    ],
  }));

  assert.equal(v2.schemaVersion, "bearing.rank.result/v2");
  assert.deepEqual(v2.ranked.map((candidate) => candidate.advisories.map((item) => item.id)), [
    ["context", "license"],
    ["context", "license"],
  ]);
  assert.equal(v2.ranked[1].advisories.find((item) => item.id === "license")?.value, "Apache-2.0");
  const withoutAdvisories = {
    ...v2,
    schemaVersion: "bearing.rank.result/v1",
    ranked: v2.ranked.map(({ advisories: _advisories, ...candidate }) => candidate),
    excluded: v2.excluded.map(({ advisories: _advisories, ...candidate }) => candidate),
  };
  assert.deepEqual(withoutAdvisories, v1);
});

test("v2 advisories distinguish missing, stale, conflicting, incomparable, and source-filtered evidence", () => {
  const stale = fact(modelA, "tool.edit.supported", true, "stale-edit", execution, "2026-07-18T21:00:00.000Z");
  const conflict = fact(modelA, "model.context.max_tokens", 65_536, "a-context-conflict");
  const incomparable: ObservationInput = {
    ...sample(modelA, true, 1000, "a-incomparable"),
    measurements: [{ key: "quality.band", kind: "sample", value: "high" }],
  };
  const unitSample = (key: string, value: number, unit: string | undefined, id: string): ObservationInput => ({
    ...sample(modelA, true, 1000, id),
    measurements: [{ key, kind: "sample", value, ...(unit === undefined ? {} : { unit }) }],
  });
  const catalog = compileCatalog([
    ...observations(),
    stale,
    conflict,
    incomparable,
    unitSample("latency.consistent", 1, "seconds", "latency-consistent-1"),
    unitSample("latency.consistent", 2, "seconds", "latency-consistent-2"),
    unitSample("latency.mixed", 1, "seconds", "latency-mixed-1"),
    unitSample("latency.mixed", 1000, "milliseconds", "latency-mixed-2"),
    unitSample("latency.partial", 1, "seconds", "latency-partial-1"),
    unitSample("latency.partial", 2, undefined, "latency-partial-2"),
  ], { asOf: "2026-07-18T22:00:00.000Z" });
  const result = rankCatalog(catalog, requestV2({
    inventory: [inventory[0]],
    requirements: [],
    preferences: [],
    advisories: [
      { id: "missing", measurementKey: "model.unknown", aggregation: "fact" },
      { id: "stale", measurementKey: "tool.edit.supported", aggregation: "fact" },
      { id: "conflict", measurementKey: "model.context.max_tokens", aggregation: "fact" },
      { id: "incomparable", measurementKey: "quality.band", aggregation: "mean" },
      { id: "first-party-context", measurementKey: "model.context.max_tokens", aggregation: "fact", sourceClasses: ["first-party"] },
      { id: "consistent-unit", measurementKey: "latency.consistent", aggregation: "mean" },
      { id: "mixed-unit", measurementKey: "latency.mixed", aggregation: "mean" },
      { id: "partial-unit", measurementKey: "latency.partial", aggregation: "mean" },
    ],
  }));
  const projections = new Map(result.ranked[0].advisories.map((item) => [item.id, item]));

  assert.equal(projections.get("missing")?.status, "missing");
  assert.equal(projections.get("stale")?.status, "stale");
  assert.deepEqual(projections.get("stale")?.evidence.evidenceIds, ["stale-edit"]);
  assert.equal(projections.get("conflict")?.status, "conflicting");
  assert.equal(projections.get("conflict")?.evidence.observationIds.length, 2);
  assert.equal(projections.get("incomparable")?.status, "incomparable");
  assert.equal(projections.get("first-party-context")?.status, "missing");
  assert.equal("value" in projections.get("conflict")!, false);
  assert.ok(projections.get("stale")?.uncertainty.gaps.includes("ADVISORY_STALE"));
  assert.equal(projections.get("consistent-unit")?.status, "present");
  assert.equal(projections.get("consistent-unit")?.value, 1.5);
  assert.equal(projections.get("consistent-unit")?.unit, "seconds");
  assert.equal(projections.get("mixed-unit")?.status, "incomparable");
  assert.equal(projections.get("partial-unit")?.status, "incomparable");
});

test("v2 advisories remain available on excluded candidates and deterministic across input ordering", () => {
  const inputs = [
    ...observations(),
    fact(modelA, "model.license", "Apache-2.0", "a-license"),
    fact(modelB, "model.license", "MIT", "b-license"),
  ];
  const first = compileCatalog(inputs, { asOf: "2026-07-18T22:00:00.000Z" });
  const second = compileCatalog([...inputs].reverse(), { asOf: "2026-07-18T22:00:00.000Z" });
  const base = requestV2({
    requirements: [{ measurementKey: "task.accepted", aggregation: "count", operator: "gte", value: 3 }],
    preferences: [],
    advisories: [
      { id: "license", measurementKey: "model.license", aggregation: "fact" },
      { id: "context", measurementKey: "model.context.max_tokens", aggregation: "fact" },
    ],
  });
  const result = rankCatalog(first, base);
  assert.equal(result.ranked.length, 0);
  assert.ok(result.excluded.every((candidate) => candidate.advisories.every((item) => item.status === "present")));
  assert.equal(
    canonicalJson(result),
    canonicalJson(rankCatalog(second, { ...base, inventory: [...base.inventory].reverse(), advisories: [...base.advisories].reverse() })),
  );
});

test("invalid rank requests fail with typed diagnostics", () => {
  const catalog = compileCatalog(observations(), { asOf: "2026-07-18T22:00:00.000Z" });
  const v1OnlyRanker: CatalogRanker = (input) => rankCatalog(catalog, input);
  assert.equal(v1OnlyRanker(request()).schemaVersion, "bearing.rank.result/v1");
  assert.throws(
    () => rankCatalog(catalog, { ...request(), inventory: [] }),
    (error: unknown) => error instanceof BearingError && error.code === "INVALID_RANK_REQUEST",
  );
  assert.throws(
    () => rankCatalog(catalog, { ...requestV2(), advisories: [
      { id: "duplicate", measurementKey: "model.context.max_tokens", aggregation: "fact" },
      { id: "duplicate", measurementKey: "model.license", aggregation: "fact" },
    ] }),
    (error: unknown) => error instanceof BearingError && error.code === "INVALID_RANK_REQUEST",
  );
  assert.throws(
    () => rankCatalog(catalog, { ...request(), advisories: [] } as RankRequest),
    (error: unknown) => error instanceof BearingError && error.code === "INVALID_RANK_REQUEST",
  );
  const expandedInventory = Array.from({ length: 33 }, (_, index) => ({ ...inventory[0], id: `candidate-${index}` }));
  const expandedAdvisories = Array.from({ length: 32 }, (_, index) => ({
    id: `advisory-${index}`,
    measurementKey: "model.context.max_tokens",
    aggregation: "fact" as const,
  }));
  assert.throws(
    () => rankCatalog(catalog, requestV2({ inventory: expandedInventory, advisories: expandedAdvisories })),
    (error: unknown) => error instanceof BearingError
      && error.code === "INVALID_RANK_REQUEST"
      && error.message.includes("projection cells"),
  );
  assert.throws(
    () => rankCatalog(catalog, requestV2({ advisories: [{
      id: "x".repeat(257),
      measurementKey: "model.context.max_tokens",
      aggregation: "fact",
    }] })),
    (error: unknown) => error instanceof BearingError
      && error.code === "INVALID_RANK_REQUEST"
      && error.message.includes("256 UTF-8 bytes"),
  );

  const inheritedRoot = Object.create(requestV2()) as RankRequestV2;
  const inheritedCandidate = requestV2({ inventory: [Object.create(inventory[0])] });
  const inheritedRequirement = requestV2({ requirements: [Object.create(request().requirements[0])] });
  const inheritedAdvisory = requestV2({ advisories: [Object.create({
    id: "context",
    measurementKey: "model.context.max_tokens",
    aggregation: "fact",
  })] });
  for (const inherited of [inheritedRoot, inheritedCandidate, inheritedRequirement, inheritedAdvisory]) {
    assert.throws(
      () => rankCatalog(catalog, inherited),
      (error: unknown) => error instanceof BearingError && error.code === "INVALID_RANK_REQUEST",
    );
  }

  let getterReads = 0;
  const accessorModel = { revision: modelA.revision, quantization: modelA.quantization } as Record<string, unknown>;
  Object.defineProperty(accessorModel, "id", {
    enumerable: true,
    get() { getterReads++; return modelA.id; },
  });
  const accessorTools = ["edit"];
  Object.defineProperty(accessorTools, "0", {
    enumerable: true,
    get() { getterReads++; return "edit"; },
  });
  const nestedInputs = [
    requestV2({ inventory: [{ ...inventory[0], model: Object.create(modelA) }] }),
    requestV2({ inventory: [{ ...inventory[0], model: accessorModel as unknown as ModelIdentity }] }),
    requestV2({ inventory: [{ ...inventory[0], execution: { ...execution, runtime: Object.create(execution.runtime) } }] }),
    requestV2({ inventory: [{ ...inventory[0], execution: { ...execution, toolSurface: accessorTools } }] }),
  ];
  for (const nested of nestedInputs) {
    assert.throws(
      () => rankCatalog(catalog, nested),
      (error: unknown) => error instanceof BearingError && error.code === "INVALID_RANK_REQUEST",
    );
  }
  assert.equal(getterReads, 0);

  const inheritedInventory = new Array(1);
  const inheritedInventoryPrototype = Object.create(Array.prototype) as unknown[];
  Object.defineProperty(inheritedInventoryPrototype, "0", {
    enumerable: true,
    get() { getterReads++; return inventory[0]; },
  });
  Object.setPrototypeOf(inheritedInventory, inheritedInventoryPrototype);
  const accessorAdvisories: unknown[] = [];
  Object.defineProperty(accessorAdvisories, "0", {
    enumerable: true,
    configurable: true,
    get() {
      getterReads++;
      return { id: "context", measurementKey: "model.context.max_tokens", aggregation: "fact" };
    },
  });
  const accessorSources: unknown[] = [];
  Object.defineProperty(accessorSources, "0", {
    enumerable: true,
    configurable: true,
    get() { getterReads++; return "external"; },
  });
  const rankArrayInputs = [
    requestV2({ inventory: inheritedInventory }),
    requestV2({ advisories: accessorAdvisories as RankRequestV2["advisories"] }),
    requestV2({ advisories: [{
      id: "context",
      measurementKey: "model.context.max_tokens",
      aggregation: "fact",
      sourceClasses: accessorSources as RankRequestV2["advisories"][number]["sourceClasses"],
    }] }),
  ];
  for (const rankArrayInput of rankArrayInputs) {
    assert.throws(
      () => rankCatalog(catalog, rankArrayInput),
      (error: unknown) => error instanceof BearingError && error.code === "INVALID_RANK_REQUEST",
    );
  }
  assert.equal(getterReads, 0);
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

  const advisoryResponse = await handler(new Request("https://bearing.example/v1/rank", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestV2({ advisories: [{ id: "context", measurementKey: "model.context.max_tokens", aggregation: "fact" }] })),
  }));
  assert.equal(advisoryResponse.status, 200);
  const advisoryResult = await advisoryResponse.json() as { schemaVersion: string; ranked: Array<{ advisories: Array<{ value?: unknown }> }> };
  assert.equal(advisoryResult.schemaVersion, "bearing.rank.result/v2");
  assert.equal(advisoryResult.ranked[0].advisories[0].value, 131_072);

  const malformed = await handler(new Request("https://bearing.example/v1/rank", {
    method: "POST",
    body: "not json",
  }));
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json() as { error: { code: string } }).error.code, "INVALID_RANK_REQUEST");

  const malformedNested = await handler(new Request("https://bearing.example/v1/rank", {
    method: "POST",
    body: JSON.stringify(requestV2({ inventory: [{ ...inventory[0], model: {} as ModelIdentity }] })),
  }));
  assert.equal(malformedNested.status, 400);
  assert.equal((await malformedNested.json() as { error: { code: string } }).error.code, "INVALID_RANK_REQUEST");

  const preflight = await handler(new Request("https://bearing.example/v1/rank", { method: "OPTIONS" }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-methods"), "POST, OPTIONS");

  const tooLarge = await handler(new Request("https://bearing.example/v1/rank", {
    method: "POST",
    headers: { "content-length": "1048577" },
    body: "{}",
  }));
  assert.equal(tooLarge.status, 413);

  let pulls = 0;
  let canceled = false;
  const chunkedBody = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array(600_000).fill(0x20));
      if (pulls === 4) controller.close();
    },
    cancel() { canceled = true; },
  });
  const chunked = await handler(new Request("https://bearing.example/v1/rank", {
    method: "POST",
    body: chunkedBody,
    duplex: "half",
  } as RequestInit & { duplex: "half" }));
  assert.equal(chunked.status, 413);
  assert.equal(canceled, true);
  assert.ok(pulls < 4);
});

test("rank HTTP responses and concurrent work are bounded", async () => {
  const catalog = compileCatalog(observations(), { asOf: "2026-07-18T22:00:00.000Z" });
  const responseBounded = createCatalogHandler({ catalog, maxRankResponseBytes: 100 });
  const oversizedResult = await responseBounded(new Request("https://bearing.example/v1/rank", {
    method: "POST",
    body: JSON.stringify(request()),
  }));
  assert.equal(oversizedResult.status, 422);
  assert.equal((await oversizedResult.json() as { error: { code: string } }).error.code, "RANK_RESULT_TOO_LARGE");

  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const reading = new Promise<void>((resolve) => { started = resolve; });
  const slowBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      started();
      await gate;
      controller.enqueue(new TextEncoder().encode(JSON.stringify(request())));
      controller.close();
    },
  });
  const capacityBounded = createCatalogHandler({ catalog, maxConcurrentRankRequests: 1 });
  const first = capacityBounded(new Request("https://bearing.example/v1/rank", {
    method: "POST",
    body: slowBody,
    duplex: "half",
  } as RequestInit & { duplex: "half" }));
  await reading;
  const second = await capacityBounded(new Request("https://bearing.example/v1/rank", {
    method: "POST",
    body: JSON.stringify(request()),
  }));
  assert.equal(second.status, 503);
  assert.equal(second.headers.get("retry-after"), "1");
  release();
  assert.equal((await first).status, 200);
});

test("the Node adapter carries rank request bodies into the same handler", async () => {
  const catalog = compileCatalog(observations(), { asOf: "2026-07-18T22:00:00.000Z" });
  const server = await startCatalogServer({ catalog, host: "127.0.0.1", port: 0, maxConcurrentRankRequests: 1 });
  try {
    const response = await fetch(`${server.url}/v1/rank`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request()),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { ranked: Array<{ candidateId: string }> }).ranked[0].candidateId, "runtime:model-b");

    const body = JSON.stringify(request());
    let stalled!: ReturnType<typeof httpRequest>;
    const firstResponse = new Promise<number>((resolve, reject) => {
      stalled = httpRequest(`${server.url}/v1/rank`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      }, (incoming) => {
        incoming.resume();
        incoming.once("end", () => resolve(incoming.statusCode ?? 0));
      });
      stalled.once("error", reject);
    });
    stalled.write(body.slice(0, 1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const capacity = await fetch(`${server.url}/v1/rank`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.equal(capacity.status, 503);
    stalled.end(body.slice(1));
    assert.equal(await firstResponse, 200);
  } finally {
    await server.close();
  }

  const responseBounded = await startCatalogServer({
    catalog,
    host: "127.0.0.1",
    port: 0,
    maxRankResponseBytes: 100,
  });
  try {
    const response = await fetch(`${responseBounded.url}/v1/rank`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request()),
    });
    assert.equal(response.status, 422);
  } finally {
    await responseBounded.close();
  }
});
