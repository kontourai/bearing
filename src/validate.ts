import { BearingError } from "./error.js";
import { allowOnlyKeys, plainArray, plainRecord, requireOwnKeys } from "./structural.js";
import {
  OBSERVATION_SCHEMA_VERSION,
  type ComponentIdentity,
  type EvaluationOutcome,
  type EvidenceReference,
  type ExecutionScope,
  type ExecutionProfile,
  type Freshness,
  type HardwareProfile,
  type Measurement,
  type MeasurementKind,
  type ModelIdentity,
  type ObservationInput,
  type ObservationKind,
  type ScalarValue,
  type SourceClass,
  type TaskProfile,
  type Uncertainty,
  type UsageObservation,
  type WorkflowProfile,
} from "./types.js";

type RecordValue = Record<string, unknown>;

const fail = (path: string, message: string): never => {
  throw new BearingError("INVALID_OBSERVATION", path, message);
};

const record = (value: unknown, path: string): RecordValue => {
  return plainRecord(value, path, fail);
};

const allowedKeys = (value: RecordValue, keys: string[], path: string): void => {
  allowOnlyKeys(value, keys, path, fail, "is not a supported field");
};

const requiredKeys = (value: RecordValue, keys: string[], path: string): void => {
  requireOwnKeys(value, keys, path, fail);
};

const array = (value: unknown, path: string, allowEmpty: boolean): unknown[] => {
  return plainArray(value, path, allowEmpty, fail);
};

const text = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    fail(path, "must be a non-empty, trimmed string");
  }
  return value as string;
};

const nullableText = (value: unknown, path: string): string | null =>
  value === null ? null : text(value, path);

const finiteNumber = (value: unknown, path: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "must be a finite number");
  return value as number;
};

const nullableInteger = (value: unknown, path: string): number | null => {
  if (value === null) return null;
  const parsed = finiteNumber(value, path);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail(path, "must be a non-negative safe integer or null");
  return parsed;
};

export const isoTimestamp = (value: unknown, path: string): string => {
  const parsed = text(value, path);
  const date = new Date(parsed);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== parsed) {
    fail(path, "must be a normalized UTC ISO-8601 timestamp");
  }
  return parsed;
};

const stringArray = (value: unknown, path: string, allowEmpty: boolean): string[] => {
  const items = array(value, path, allowEmpty);
  const result = items.map((item: unknown, index: number) => text(item, `${path}[${index}]`));
  if (new Set(result).size !== result.length) fail(path, "must not contain duplicates");
  return result;
};

const component = (value: unknown, path: string): ComponentIdentity => {
  const item = record(value, path);
  allowedKeys(item, ["id", "version"], path);
  requiredKeys(item, ["id", "version"], path);
  return { id: text(item.id, `${path}.id`), version: nullableText(item.version, `${path}.version`) };
};

export const validateModelIdentity = (value: unknown, path = "$"): ModelIdentity => {
  const item = record(value, path);
  allowedKeys(item, ["id", "revision", "quantization"], path);
  requiredKeys(item, ["id", "revision", "quantization"], path);
  return {
    id: text(item.id, `${path}.id`),
    revision: nullableText(item.revision, `${path}.revision`),
    quantization: nullableText(item.quantization, `${path}.quantization`),
  };
};

const hardware = (value: unknown, path: string): HardwareProfile | null => {
  if (value === null) return null;
  const item = record(value, path);
  allowedKeys(item, ["class", "accelerator", "memoryBytes"], path);
  requiredKeys(item, ["class", "accelerator", "memoryBytes"], path);
  return {
    class: text(item.class, `${path}.class`),
    accelerator: nullableText(item.accelerator, `${path}.accelerator`),
    memoryBytes: nullableInteger(item.memoryBytes, `${path}.memoryBytes`),
  };
};

const workflow = (value: unknown, path: string): WorkflowProfile | null => {
  if (value === null) return null;
  const item = record(value, path);
  allowedKeys(item, ["id", "version", "condition"], path);
  requiredKeys(item, ["id", "version", "condition"], path);
  return {
    id: text(item.id, `${path}.id`),
    version: nullableText(item.version, `${path}.version`),
    condition: nullableText(item.condition, `${path}.condition`),
  };
};

export const validateExecutionProfile = (value: unknown, path = "$"): ExecutionProfile | null => {
  if (value === null) return null;
  const item = record(value, path);
  allowedKeys(item, ["runtime", "adapter", "effectiveContextTokens", "toolSurface", "hardware", "workflow"], path);
  requiredKeys(item, ["runtime", "adapter", "effectiveContextTokens", "toolSurface", "hardware", "workflow"], path);
  return {
    runtime: component(item.runtime, `${path}.runtime`),
    adapter: item.adapter === null ? null : component(item.adapter, `${path}.adapter`),
    effectiveContextTokens: nullableInteger(item.effectiveContextTokens, `${path}.effectiveContextTokens`),
    toolSurface: stringArray(item.toolSurface, `${path}.toolSurface`, true),
    hardware: hardware(item.hardware, `${path}.hardware`),
    workflow: workflow(item.workflow, `${path}.workflow`),
  };
};

export const validateExecutionScope = (value: unknown, path = "$"): ExecutionScope | null => {
  if (value === null) return null;
  const item = record(value, path);
  const keys = ["kind", "runtime", "adapter", "effectiveContextTokens", "toolSurface", "hardware", "workflow"];
  allowedKeys(item, keys, path);
  requiredKeys(item, keys, path);
  if (item.kind !== "exact" && item.kind !== "partial") {
    fail(`${path}.kind`, "must be exact or partial");
  }
  const common = {
    runtime: component(item.runtime, `${path}.runtime`),
    adapter: item.adapter === null ? null : component(item.adapter, `${path}.adapter`),
    effectiveContextTokens: nullableInteger(item.effectiveContextTokens, `${path}.effectiveContextTokens`),
    hardware: hardware(item.hardware, `${path}.hardware`),
    workflow: workflow(item.workflow, `${path}.workflow`),
  };
  return item.kind === "exact"
    ? { kind: "exact", ...common, toolSurface: stringArray(item.toolSurface, `${path}.toolSurface`, true) }
    : {
        kind: "partial",
        ...common,
        toolSurface: item.toolSurface === null ? null : stringArray(item.toolSurface, `${path}.toolSurface`, true),
      };
};

const task = (value: unknown, path: string): TaskProfile | null => {
  if (value === null) return null;
  const item = record(value, path);
  allowedKeys(item, ["family", "suite", "taskId", "evaluator"], path);
  requiredKeys(item, ["family", "suite", "taskId", "evaluator"], path);
  return {
    family: text(item.family, `${path}.family`),
    suite: nullableText(item.suite, `${path}.suite`),
    taskId: nullableText(item.taskId, `${path}.taskId`),
    evaluator: component(item.evaluator, `${path}.evaluator`),
  };
};

const measurement = (value: unknown, path: string): Measurement => {
  const item = record(value, path);
  allowedKeys(item, ["key", "kind", "value", "unit"], path);
  requiredKeys(item, ["key", "kind", "value"], path);
  if (item.kind !== "fact" && item.kind !== "sample") fail(`${path}.kind`, "must be fact or sample");
  if (typeof item.value !== "string" && typeof item.value !== "number" && typeof item.value !== "boolean") {
    fail(`${path}.value`, "must be a string, number, or boolean");
  }
  if (typeof item.value === "number") finiteNumber(item.value, `${path}.value`);
  return {
    key: text(item.key, `${path}.key`),
    kind: item.kind as MeasurementKind,
    value: item.value as ScalarValue,
    ...(item.unit === undefined ? {} : { unit: text(item.unit, `${path}.unit`) }),
  };
};

const outcome = (value: unknown, path: string): EvaluationOutcome | null => {
  if (value === null) return null;
  const item = record(value, path);
  allowedKeys(item, ["status", "reason"], path);
  requiredKeys(item, ["status", "reason"], path);
  if (item.status !== "accepted" && item.status !== "rejected" && item.status !== "invalid") {
    fail(`${path}.status`, "must be accepted, rejected, or invalid");
  }
  return {
    status: item.status as EvaluationOutcome["status"],
    reason: nullableText(item.reason, `${path}.reason`),
  };
};

const usage = (value: unknown, path: string): UsageObservation | null => {
  if (value === null) return null;
  const item = record(value, path);
  const keys = ["inputTokens", "outputTokens", "reasoningTokens", "totalTokens", "completeness", "modelCalls", "wallTimeMs"];
  allowedKeys(item, keys, path);
  requiredKeys(item, keys, path);
  if (item.completeness !== "complete" && item.completeness !== "partial" && item.completeness !== "unknown") {
    fail(`${path}.completeness`, "must be complete, partial, or unknown");
  }
  return {
    inputTokens: nullableInteger(item.inputTokens, `${path}.inputTokens`),
    outputTokens: nullableInteger(item.outputTokens, `${path}.outputTokens`),
    reasoningTokens: nullableInteger(item.reasoningTokens, `${path}.reasoningTokens`),
    totalTokens: nullableInteger(item.totalTokens, `${path}.totalTokens`),
    completeness: item.completeness as UsageObservation["completeness"],
    modelCalls: nullableInteger(item.modelCalls, `${path}.modelCalls`),
    wallTimeMs: nullableInteger(item.wallTimeMs, `${path}.wallTimeMs`),
  };
};

const evidence = (value: unknown, path: string): EvidenceReference => {
  const item = record(value, path);
  allowedKeys(item, ["id", "kind", "uri", "digest", "observedAt"], path);
  requiredKeys(item, ["id", "kind", "uri", "digest", "observedAt"], path);
  let digest = null;
  if (item.digest !== null) {
    const raw = record(item.digest, `${path}.digest`);
    allowedKeys(raw, ["algorithm", "value"], `${path}.digest`);
    requiredKeys(raw, ["algorithm", "value"], `${path}.digest`);
    if (raw.algorithm !== "sha256") fail(`${path}.digest.algorithm`, "must be sha256");
    const valueText = text(raw.value, `${path}.digest.value`);
    if (!/^[a-f0-9]{64}$/.test(valueText)) fail(`${path}.digest.value`, "must be a lowercase sha256 hex digest");
    digest = { algorithm: "sha256" as const, value: valueText };
  }
  return {
    id: text(item.id, `${path}.id`),
    kind: text(item.kind, `${path}.kind`),
    uri: nullableText(item.uri, `${path}.uri`),
    digest,
    observedAt: isoTimestamp(item.observedAt, `${path}.observedAt`),
  };
};

const freshness = (value: unknown, path: string): Freshness => {
  const item = record(value, path);
  allowedKeys(item, ["observedAt", "validUntil"], path);
  requiredKeys(item, ["observedAt", "validUntil"], path);
  const observedAt = isoTimestamp(item.observedAt, `${path}.observedAt`);
  const validUntil = item.validUntil === null ? null : isoTimestamp(item.validUntil, `${path}.validUntil`);
  if (validUntil !== null && validUntil <= observedAt) fail(`${path}.validUntil`, "must be later than observedAt");
  return { observedAt, validUntil };
};

const uncertainty = (value: unknown, path: string): Uncertainty => {
  const item = record(value, path);
  allowedKeys(item, ["level", "basis", "gaps"], path);
  requiredKeys(item, ["level", "basis", "gaps"], path);
  if (item.level !== "low" && item.level !== "moderate" && item.level !== "high" && item.level !== "unknown") {
    fail(`${path}.level`, "must be low, moderate, high, or unknown");
  }
  return {
    level: item.level as Uncertainty["level"],
    basis: stringArray(item.basis, `${path}.basis`, false),
    gaps: stringArray(item.gaps, `${path}.gaps`, true),
  };
};

export const validateObservation = (value: unknown): ObservationInput => {
  const item = record(value, "$");
  const keys = ["schemaVersion", "kind", "model", "execution", "task", "measurements", "outcome", "usage", "sourceClass", "evidence", "freshness", "uncertainty"];
  allowedKeys(item, keys, "$");
  requiredKeys(item, keys, "$");
  if (item.schemaVersion !== OBSERVATION_SCHEMA_VERSION) {
    throw new BearingError("UNSUPPORTED_SCHEMA", "$.schemaVersion", `expected ${OBSERVATION_SCHEMA_VERSION}`);
  }
  if (item.kind !== "evaluation" && item.kind !== "declaration") fail("$.kind", "must be evaluation or declaration");
  if (item.sourceClass !== "first-party" && item.sourceClass !== "external") {
    fail("$.sourceClass", "must be first-party or external");
  }
  const measurementValues = array(item.measurements, "$.measurements", false);
  const measurements = measurementValues.map((entry: unknown, index: number) => measurement(entry, `$.measurements[${index}]`));
  const measurementIds = measurements.map((entry) => `${entry.kind}:${entry.key}`);
  if (new Set(measurementIds).size !== measurementIds.length) fail("$.measurements", "must not repeat a kind/key pair");
  const evidenceValues = array(item.evidence, "$.evidence", false);
  const evidenceItems = evidenceValues.map((entry: unknown, index: number) => evidence(entry, `$.evidence[${index}]`));
  if (new Set(evidenceItems.map((entry) => entry.id)).size !== evidenceItems.length) fail("$.evidence", "must not repeat evidence ids");

  const result: ObservationInput = {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    kind: item.kind as ObservationKind,
    model: validateModelIdentity(item.model, "$.model"),
    execution: validateExecutionScope(item.execution, "$.execution"),
    task: task(item.task, "$.task"),
    measurements,
    outcome: outcome(item.outcome, "$.outcome"),
    usage: usage(item.usage, "$.usage"),
    sourceClass: item.sourceClass as SourceClass,
    evidence: evidenceItems,
    freshness: freshness(item.freshness, "$.freshness"),
    uncertainty: uncertainty(item.uncertainty, "$.uncertainty"),
  };

  if (result.kind === "evaluation") {
    const execution = result.execution;
    if (execution === null) fail("$.execution", "is required for an evaluation");
    else if (execution.kind !== "exact") fail("$.execution.kind", "must be exact for an evaluation");
    if (result.task === null) fail("$.task", "is required for an evaluation");
    if (result.outcome === null) fail("$.outcome", "is required for an evaluation");
  } else {
    if (result.outcome !== null) fail("$.outcome", "must be null for a declaration");
    if (result.usage !== null) fail("$.usage", "must be null for a declaration");
  }
  return result;
};
