import assert from "node:assert/strict";
import test from "node:test";

import {
  compileCatalog,
  rankCatalog,
  type ExecutionProfile,
  type ModelIdentity,
  type ObservationInput,
  type RankRequest,
  type RankRequestV2,
} from "../src/index.js";

const asOf = "2026-07-18T22:00:00.000Z";
const observedAt = "2026-07-18T20:00:00.000Z";
const model: ModelIdentity = { id: "example/model-a", revision: "r1", quantization: "q8" };
const execution: ExecutionProfile = {
  runtime: { id: "local-runtime", version: "1.0.0" },
  adapter: { id: "agent-adapter", version: "4.2.0" },
  effectiveContextTokens: 32_768,
  toolSurface: ["edit", "shell"],
  hardware: { class: "desktop-gpu", accelerator: "gpu", memoryBytes: 24_000_000_000 },
  workflow: { id: "builder", version: "4.2.0", condition: "kit" },
};

const fact = (key: string, value: string | number | boolean, id: string): ObservationInput => ({
  schemaVersion: "bearing.observation/v2",
  kind: "declaration",
  model,
  execution: null,
  task: null,
  measurements: [{ key, kind: "fact", value }],
  outcome: null,
  usage: null,
  sourceClass: "external",
  evidence: [{ id, kind: "source", uri: null, digest: null, observedAt }],
  freshness: { observedAt, validUntil: null },
  uncertainty: { level: "moderate", basis: ["source declaration"], gaps: [] },
});

const sample = (): ObservationInput => ({
  schemaVersion: "bearing.observation/v2",
  kind: "evaluation",
  model,
  execution: { kind: "exact", ...execution },
  task: { family: "software-engineering", suite: "example-suite", taskId: "task-1", evaluator: { id: "grader", version: "1" } },
  measurements: [{ key: "task.accepted", kind: "sample", value: true }],
  outcome: { status: "accepted", reason: null },
  usage: { inputTokens: 500, outputTokens: 500, reasoningTokens: null, totalTokens: 1_000, completeness: "complete", modelCalls: 1, wallTimeMs: 1_000 },
  sourceClass: "first-party",
  evidence: [{ id: "exact-sample", kind: "eval-result", uri: null, digest: null, observedAt }],
  freshness: { observedAt, validUntil: null },
  uncertainty: { level: "moderate", basis: ["independent grader"], gaps: [] },
});

const request = (overrides: Partial<Omit<RankRequest, "schemaVersion">> = {}): RankRequest => ({
  schemaVersion: "bearing.rank.request/v1",
  task: { family: "software-engineering", suite: null },
  inventory: [{ id: "local:model-a", model, execution }],
  requirements: [],
  preferences: [],
  ...overrides,
});

const requestV2 = (overrides: Partial<Omit<RankRequestV2, "schemaVersion">> = {}): RankRequestV2 => ({
  ...request(overrides),
  schemaVersion: "bearing.rank.request/v2",
  advisories: [],
  ...overrides,
});

test("partial declarations match asserted runtime dimensions and explain wildcarded fields", () => {
  const partial: ObservationInput = {
    ...fact("openrouter.model.context.max_tokens", 1_050_000, "openrouter-context"),
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
  const catalog = compileCatalog([partial], { asOf });
  const openrouter = {
    id: "openrouter:model-a",
    model,
    execution: {
      ...execution,
      runtime: { id: "openrouter", version: "2026-07-18" },
      adapter: { id: "caller-openrouter-adapter", version: "9.0.0" },
      toolSurface: ["browser", "shell"],
    },
  };
  const local = { id: "local:model-a", model, execution };
  const result = rankCatalog(catalog, requestV2({
    inventory: [local, openrouter],
    requirements: [{
      measurementKey: "openrouter.model.context.max_tokens",
      aggregation: "fact",
      operator: "gte",
      value: 1_000_000,
    }],
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
  assert.deepEqual(result.excluded[0].reasons[0].executionApplicability?.mismatchedDimensions, ["runtime.id"]);
  assert.deepEqual(result.excluded[0].evidence[0].evidenceIds, ["openrouter-context"]);
});

test("successful applicability summarizes only contributing requirements and preferences", () => {
  const scoped = (runtimeId: string, evidenceId: string): ObservationInput => ({
    ...fact("runtime.context", 1_050_000, evidenceId),
    execution: {
      kind: "partial",
      runtime: { id: runtimeId, version: null },
      adapter: null,
      effectiveContextTokens: null,
      toolSurface: null,
      hardware: null,
      workflow: null,
    },
  });
  const catalog = compileCatalog([
    scoped("openrouter", "matching-openrouter-context"),
    scoped("local-runtime", "unrelated-local-context"),
  ], { asOf });
  const candidate = {
    id: "openrouter:model-a",
    model,
    execution: { ...execution, runtime: { id: "openrouter", version: "2026-07-18" } },
  };
  const requirement = { measurementKey: "runtime.context", aggregation: "fact" as const, operator: "gte" as const, value: 1_000_000 };
  const v2 = rankCatalog(catalog, requestV2({ inventory: [candidate], requirements: [requirement] }));
  assert.deepEqual(v2.ranked[0].reasons[0].executionApplicability?.mismatchedDimensions, []);
  assert.deepEqual(v2.ranked[0].evidence[0].evidenceIds, ["matching-openrouter-context"]);

  const v1 = rankCatalog(catalog, request({ inventory: [candidate], requirements: [requirement] }));
  assert.equal(Object.hasOwn(v1.ranked[0].reasons[0], "executionApplicability"), false);

  const preference = { measurementKey: "runtime.context", aggregation: "fact" as const, direction: "maximize" as const, weight: 1 };
  const preferenceV2 = rankCatalog(catalog, requestV2({ inventory: [candidate], preferences: [preference] }));
  const preferenceReasonV2 = preferenceV2.ranked[0].reasons.find((reason) => reason.code === "PREFERENCE_SCORE")!;
  assert.deepEqual(preferenceReasonV2.executionApplicability?.mismatchedDimensions, []);
  assert.deepEqual(preferenceReasonV2.executionApplicability?.matchedKinds, ["partial"]);

  const preferenceV1 = rankCatalog(catalog, request({ inventory: [candidate], preferences: [preference] }));
  const preferenceReasonV1 = preferenceV1.ranked[0].reasons.find((reason) => reason.code === "PREFERENCE_SCORE")!;
  assert.equal(Object.hasOwn(preferenceReasonV1, "executionApplicability"), false);

  const nonnumeric = scoped("openrouter", "nonnumeric-openrouter-context");
  nonnumeric.measurements = [{ key: "runtime.context", kind: "fact", value: "large" }];
  const nonnumericResult = rankCatalog(compileCatalog([nonnumeric], { asOf }), requestV2({
    inventory: [candidate],
    preferences: [preference],
  }));
  const incomparable = nonnumericResult.ranked[0].reasons.find((reason) => reason.code === "INCOMPARABLE_EVIDENCE")!;
  assert.deepEqual(incomparable.executionApplicability?.matchedKinds, ["partial"]);
  assert.deepEqual(incomparable.executionApplicability?.mismatchedDimensions, []);
});

test("partial scope nulls are wildcards while empty tools remain known-empty", () => {
  const partial: ObservationInput = {
    ...fact("runtime.ready", true, "partial-runtime-ready"),
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
  const catalog = compileCatalog([partial], { asOf });
  const knownEmpty = { ...execution, toolSurface: [] };
  const matching = rankCatalog(catalog, requestV2({
    inventory: [{ id: "empty-tools", model, execution: knownEmpty }],
    requirements: [{ measurementKey: "runtime.ready", aggregation: "fact", operator: "eq", value: true }],
  }));
  const applicability = matching.ranked[0].reasons[0].executionApplicability!;
  assert.ok(applicability.assertedDimensions.includes("toolSurface"));
  assert.ok(applicability.wildcardedDimensions.includes("hardware.accelerator"));
  assert.ok(applicability.wildcardedDimensions.includes("hardware.memoryBytes"));
  assert.ok(applicability.wildcardedDimensions.includes("workflow.version"));

  const mismatches: Array<[string, ExecutionProfile]> = [
    ["toolSurface", execution],
    ["adapter.id", { ...knownEmpty, adapter: { id: "other-adapter", version: "4.2.0" } }],
    ["effectiveContextTokens", { ...knownEmpty, effectiveContextTokens: 16_384 }],
    ["hardware.class", { ...knownEmpty, hardware: { ...knownEmpty.hardware!, class: "server-gpu" } }],
    ["workflow.condition", { ...knownEmpty, workflow: { ...knownEmpty.workflow!, condition: "bare" } }],
  ];
  for (const [dimension, candidateExecution] of mismatches) {
    const result = rankCatalog(catalog, requestV2({
      inventory: [{ id: dimension, model, execution: candidateExecution }],
      requirements: [{ measurementKey: "runtime.ready", aggregation: "fact", operator: "eq", value: true }],
    }));
    assert.deepEqual(result.excluded[0].reasons[0].executionApplicability?.mismatchedDimensions, [dimension]);
  }
});

test("partial nested versions and optional components match only when asserted", () => {
  const partial: ObservationInput = {
    ...fact("runtime.ready", true, "partial-versioned-runtime"),
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
  const catalog = compileCatalog([partial], { asOf });
  const matchingExecution: ExecutionProfile = {
    ...execution,
    runtime: { ...execution.runtime, version: "1.2.3" },
    hardware: { ...execution.hardware!, accelerator: "gpu-1" },
    workflow: { ...execution.workflow!, version: "2.0.0" },
  };
  const mismatches: Array<[string, ExecutionProfile]> = [
    ["adapter", { ...matchingExecution, adapter: null }],
    ["runtime.version", { ...matchingExecution, runtime: { ...matchingExecution.runtime, version: "1.2.4" } }],
    ["adapter.version", { ...matchingExecution, adapter: { ...matchingExecution.adapter!, version: "4.3.0" } }],
    ["hardware", { ...matchingExecution, hardware: null }],
    ["hardware.accelerator", { ...matchingExecution, hardware: { ...matchingExecution.hardware!, accelerator: "gpu-2" } }],
    ["hardware.memoryBytes", { ...matchingExecution, hardware: { ...matchingExecution.hardware!, memoryBytes: 16_000_000_000 } }],
    ["workflow", { ...matchingExecution, workflow: null }],
    ["workflow.version", { ...matchingExecution, workflow: { ...matchingExecution.workflow!, version: "2.1.0" } }],
  ];
  for (const [dimension, candidateExecution] of mismatches) {
    const result = rankCatalog(catalog, requestV2({
      inventory: [{ id: dimension, model, execution: candidateExecution }],
      requirements: [{ measurementKey: "runtime.ready", aggregation: "fact", operator: "eq", value: true }],
    }));
    assert.deepEqual(result.excluded[0].reasons[0].executionApplicability?.mismatchedDimensions, [dimension]);
  }
});

test("exact evaluation scopes remain exact after partial matching is introduced", () => {
  const catalog = compileCatalog([sample()], { asOf });
  const result = rankCatalog(catalog, requestV2({
    inventory: [{ id: "other-adapter", model, execution: { ...execution, adapter: { id: "other-adapter", version: "1.0.0" } } }],
    requirements: [{ measurementKey: "task.accepted", aggregation: "count", operator: "gte", value: 1 }],
  }));
  assert.equal(result.excluded[0].reasons[0].code, "INCOMPARABLE_EVIDENCE");
  assert.deepEqual(result.excluded[0].reasons[0].executionApplicability?.mismatchedDimensions, ["adapter"]);
});

test("advisories expose partial-scope applicability without changing ranking", () => {
  const partial: ObservationInput = {
    ...fact("runtime.context", 1_050_000, "advisory-partial"),
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
  const catalog = compileCatalog([partial], { asOf });
  const result = rankCatalog(catalog, requestV2({
    inventory: [{ id: "openrouter:model-a", model, execution: { ...execution, runtime: { id: "openrouter", version: "2026-07-18" } } }],
    advisories: [{ id: "context", measurementKey: "runtime.context", aggregation: "fact" }],
  }));
  assert.equal(result.ranked[0].advisories[0].status, "present");
  assert.deepEqual(result.ranked[0].advisories[0].executionApplicability.matchedKinds, ["partial"]);
  assert.deepEqual(result.ranked[0].advisories[0].executionApplicability.assertedDimensions, ["runtime.id"]);
});
