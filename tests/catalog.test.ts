import assert from "node:assert/strict";
import test from "node:test";

import {
  BearingError,
  compileCatalog,
  normalizeObservation,
  type ObservationInput,
} from "../src/index.js";

const baseObservation = (overrides: Partial<ObservationInput> = {}): ObservationInput => ({
  schemaVersion: "bearing.observation/v1",
  kind: "evaluation",
  model: {
    id: "example/model-7b",
    revision: "r1",
    quantization: "q8",
  },
  execution: {
    runtime: { id: "local-runtime", version: "1.2.3" },
    adapter: { id: "agent-adapter", version: "4.2.0" },
    effectiveContextTokens: 32_768,
    toolSurface: ["shell", "edit"],
    hardware: { class: "desktop-gpu", accelerator: "gpu", memoryBytes: 24_000_000_000 },
    workflow: { id: "builder", version: "4.2.0", condition: "kit" },
  },
  task: {
    family: "software-engineering",
    suite: "example-suite",
    taskId: "task-1",
    evaluator: { id: "example-grader", version: "v1" },
  },
  measurements: [
    { key: "task.accepted", kind: "sample", value: true },
    { key: "usage.total_tokens", kind: "sample", value: 1250, unit: "tokens" },
  ],
  outcome: { status: "accepted", reason: null },
  usage: {
    inputTokens: 1000,
    outputTokens: 250,
    reasoningTokens: null,
    totalTokens: 1250,
    completeness: "complete",
    modelCalls: 1,
    wallTimeMs: 2500,
  },
  sourceClass: "first-party",
  evidence: [
    {
      id: "eval-result",
      kind: "eval-result",
      uri: "artifact://evals/example.jsonl#task-1",
      digest: { algorithm: "sha256", value: "a".repeat(64) },
      observedAt: "2026-07-18T20:00:00.000Z",
    },
  ],
  freshness: {
    observedAt: "2026-07-18T20:00:00.000Z",
    validUntil: null,
  },
  uncertainty: {
    level: "low",
    basis: ["independent grader"],
    gaps: [],
  },
  ...overrides,
});

test("normalization is deterministic and computes an observation id", () => {
  const first = normalizeObservation(baseObservation());
  const reordered = normalizeObservation(baseObservation({
    execution: {
      ...baseObservation().execution!,
      toolSurface: ["edit", "shell"],
    },
    measurements: [...baseObservation().measurements].reverse(),
  }));

  assert.deepEqual(first, reordered);
  assert.match(first.id, /^[a-f0-9]{64}$/);
  assert.deepEqual(first.execution?.toolSurface, ["edit", "shell"]);
});

test("catalog output and digest are stable across input ordering", () => {
  const second = baseObservation({
    model: { id: "example/model-14b", revision: "r2", quantization: null },
    freshness: { observedAt: "2026-07-18T21:00:00.000Z", validUntil: null },
    evidence: [{
      id: "eval-result-2",
      kind: "eval-result",
      uri: "artifact://evals/example.jsonl#task-2",
      digest: { algorithm: "sha256", value: "b".repeat(64) },
      observedAt: "2026-07-18T21:00:00.000Z",
    }],
  });

  const a = compileCatalog([baseObservation(), second], { asOf: "2026-07-18T22:00:00.000Z" });
  const b = compileCatalog([second, baseObservation()], { asOf: "2026-07-18T22:00:00.000Z" });

  assert.deepEqual(a, b);
  assert.match(a.digest, /^[a-f0-9]{64}$/);
  assert.equal(a.models.length, 2);
});

test("revision, quantization, and execution scopes remain distinct", () => {
  const observations = [
    baseObservation(),
    baseObservation({ model: { id: "example/model-7b", revision: "r2", quantization: "q8" } }),
    baseObservation({ model: { id: "example/model-7b", revision: "r1", quantization: "q4" } }),
    baseObservation({
      execution: {
        ...baseObservation().execution!,
        runtime: { id: "other-runtime", version: null },
      },
    }),
  ];

  const catalog = compileCatalog(observations, { asOf: "2026-07-18T22:00:00.000Z" });
  assert.equal(catalog.models.length, 3);
  assert.equal(catalog.models.find((model) => model.identity.revision === "r1" && model.identity.quantization === "q8")?.observations.length, 2);
});

test("different overlapping fact values are retained as a conflict", () => {
  const declared = (value: number, evidenceId: string): ObservationInput => ({
    schemaVersion: "bearing.observation/v1",
    kind: "declaration",
    model: { id: "example/model-7b", revision: "r1", quantization: null },
    execution: null,
    task: null,
    measurements: [{ key: "model.context.max_tokens", kind: "fact", value, unit: "tokens" }],
    outcome: null,
    usage: null,
    sourceClass: "external",
    evidence: [{
      id: evidenceId,
      kind: "model-card",
      uri: `https://example.test/${evidenceId}`,
      digest: null,
      observedAt: "2026-07-18T20:00:00.000Z",
    }],
    freshness: { observedAt: "2026-07-18T20:00:00.000Z", validUntil: "2026-08-18T20:00:00.000Z" },
    uncertainty: { level: "moderate", basis: ["publisher declaration"], gaps: [] },
  });

  const catalog = compileCatalog(
    [declared(32_768, "card-a"), declared(131_072, "card-b")],
    { asOf: "2026-07-18T22:00:00.000Z" },
  );

  assert.equal(catalog.conflicts.length, 1);
  assert.equal(catalog.conflicts[0].measurementKey, "model.context.max_tokens");
  assert.deepEqual(catalog.conflicts[0].values, [32_768, 131_072]);
  assert.equal(catalog.models[0].observations.length, 2);
});

test("different sample values are retained without a fact conflict", () => {
  const rejected = baseObservation({
    measurements: [{ key: "task.accepted", kind: "sample", value: false }],
    outcome: { status: "rejected", reason: "tests failed" },
    evidence: [{
      id: "eval-result-rejected",
      kind: "eval-result",
      uri: "artifact://evals/example.jsonl#rejected",
      digest: { algorithm: "sha256", value: "c".repeat(64) },
      observedAt: "2026-07-18T20:10:00.000Z",
    }],
    freshness: { observedAt: "2026-07-18T20:10:00.000Z", validUntil: null },
  });
  const catalog = compileCatalog([baseObservation(), rejected], { asOf: "2026-07-18T22:00:00.000Z" });
  assert.equal(catalog.conflicts.length, 0);
  assert.equal(catalog.models[0].observations.length, 2);
});

test("non-overlapping historical facts do not form a conflict", () => {
  const declaration = (value: number, observedAt: string, validUntil: string | null, id: string): ObservationInput => ({
    schemaVersion: "bearing.observation/v1",
    kind: "declaration",
    model: { id: "example/model-7b", revision: "r1", quantization: null },
    execution: null,
    task: null,
    measurements: [{ key: "model.context.max_tokens", kind: "fact", value, unit: "tokens" }],
    outcome: null,
    usage: null,
    sourceClass: "external",
    evidence: [{ id, kind: "model-card", uri: `https://example.test/${id}`, digest: null, observedAt }],
    freshness: { observedAt, validUntil },
    uncertainty: { level: "moderate", basis: ["publisher declaration"], gaps: [] },
  });
  const catalog = compileCatalog([
    declaration(32_768, "2026-06-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z", "old"),
    declaration(131_072, "2026-07-01T00:00:00.000Z", null, "new"),
  ], { asOf: "2026-07-18T22:00:00.000Z" });
  assert.equal(catalog.conflicts.length, 0);
});

test("catalog asOf rejects observations and evidence from the future", () => {
  assert.throws(
    () => compileCatalog([baseObservation()], { asOf: "2026-07-18T19:59:59.999Z" }),
    (error: unknown) => error instanceof BearingError
      && error.code === "INVALID_COMPILE_OPTIONS"
      && error.path === "$.observations[0].freshness.observedAt",
  );
});

test("duplicate normalized observations fail with a typed diagnostic", () => {
  assert.throws(
    () => compileCatalog([baseObservation(), baseObservation()], { asOf: "2026-07-18T22:00:00.000Z" }),
    (error: unknown) => error instanceof BearingError && error.code === "DUPLICATE_OBSERVATION",
  );
});

test("unsupported schema and incomplete evaluation scope fail explicitly", () => {
  assert.throws(
    () => normalizeObservation({ ...baseObservation(), schemaVersion: "bearing.observation/v2" as never }),
    (error: unknown) => error instanceof BearingError && error.code === "UNSUPPORTED_SCHEMA",
  );
  assert.throws(
    () => normalizeObservation(baseObservation({ execution: null })),
    (error: unknown) => error instanceof BearingError && error.code === "INVALID_OBSERVATION" && error.path === "$.execution",
  );
});

test("unknown fields and invalid timestamps are rejected", () => {
  const withUnknown = { ...baseObservation(), secretScore: 99 } as ObservationInput;
  assert.throws(
    () => normalizeObservation(withUnknown),
    (error: unknown) => error instanceof BearingError && error.code === "INVALID_OBSERVATION",
  );
  assert.throws(
    () => normalizeObservation(baseObservation({ freshness: { observedAt: "yesterday", validUntil: null } })),
    (error: unknown) => error instanceof BearingError && error.path === "$.freshness.observedAt",
  );
});
