import { canonicalJson, compareText } from "./canonical.js";
import { BearingError } from "./error.js";
import type {
  CapabilityObservation,
  CatalogSnapshot,
  ExecutionProfile,
  ExecutionScope,
  ModelIdentity,
  ScalarValue,
  SourceClass,
  Uncertainty,
} from "./types.js";
import { validateCatalogSnapshot } from "./snapshot.js";
import { allowOnlyKeys, plainArray, plainRecord, requireOwnKeys } from "./structural.js";
import { validateExecutionProfile, validateModelIdentity } from "./validate.js";

export const RANK_REQUEST_SCHEMA_VERSION = "bearing.rank.request/v1" as const;
export const RANK_RESULT_SCHEMA_VERSION = "bearing.rank.result/v1" as const;
export const RANK_REQUEST_SCHEMA_VERSION_V2 = "bearing.rank.request/v2" as const;
export const RANK_RESULT_SCHEMA_VERSION_V2 = "bearing.rank.result/v2" as const;
export const MAX_RANK_V2_CANDIDATES = 128;
export const MAX_RANK_V2_CRITERIA = 128;
export const MAX_RANK_V2_ADVISORIES = 64;
export const MAX_RANK_V2_ADVISORY_CELLS = 1_024;
export const MAX_RANK_V2_TEXT_BYTES = 256;

export type Aggregation = "fact" | "mean" | "min" | "max" | "success-rate" | "count";

export interface RankTask {
  family: string;
  suite: string | null;
}

export interface RuntimeCandidate {
  id: string;
  model: ModelIdentity;
  execution: ExecutionProfile;
}

export interface RankRequirement {
  measurementKey: string;
  aggregation: Aggregation;
  operator: "eq" | "gte" | "lte";
  value: ScalarValue;
  sourceClasses?: SourceClass[];
}

export interface RankPreference {
  measurementKey: string;
  aggregation: Aggregation;
  direction: "maximize" | "minimize";
  weight: number;
  sourceClasses?: SourceClass[];
}

export interface RankAdvisoryRequest {
  /** Stable caller-owned id used to consume this projection without key inference. */
  id: string;
  measurementKey: string;
  aggregation: Aggregation;
  sourceClasses?: SourceClass[];
}

export interface RankRequest {
  schemaVersion: typeof RANK_REQUEST_SCHEMA_VERSION;
  task: RankTask;
  inventory: RuntimeCandidate[];
  requirements: RankRequirement[];
  preferences: RankPreference[];
}

export interface RankRequestV2 {
  schemaVersion: typeof RANK_REQUEST_SCHEMA_VERSION_V2;
  task: RankTask;
  inventory: RuntimeCandidate[];
  requirements: RankRequirement[];
  preferences: RankPreference[];
  advisories: RankAdvisoryRequest[];
}

export type AnyRankRequest = RankRequest | RankRequestV2;

export type RankReasonCode =
  | "REQUIREMENT_MET"
  | "REQUIREMENT_NOT_MET"
  | "MISSING_EVIDENCE"
  | "STALE_EVIDENCE"
  | "CONFLICTING_EVIDENCE"
  | "INCOMPARABLE_EVIDENCE"
  | "PREFERENCE_EVIDENCE_MISSING"
  | "PREFERENCE_SCORE";

export interface RankReason {
  code: RankReasonCode;
  measurementKey: string;
  summary: string;
  actual?: ScalarValue;
  expected?: ScalarValue;
  contribution?: number;
  executionApplicability?: ExecutionApplicabilitySummary;
}

export interface RankEvidence {
  measurementKey: string;
  observationIds: string[];
  evidenceIds: string[];
}

export type ObservationExecutionScopeKind = "global" | "exact" | "partial";

export interface ExecutionApplicabilitySummary {
  matchedKinds: ObservationExecutionScopeKind[];
  assertedDimensions: string[];
  wildcardedDimensions: string[];
  mismatchedDimensions: string[];
}

export type RankAdvisoryStatus = "present" | "missing" | "stale" | "conflicting" | "incomparable";

interface RankAdvisoryProjectionBase {
  id: string;
  measurementKey: string;
  aggregation: Aggregation;
  sourceClasses?: SourceClass[];
  evidence: RankEvidence;
  uncertainty: Uncertainty;
  executionApplicability: ExecutionApplicabilitySummary;
}

export type RankAdvisoryProjection =
  | (RankAdvisoryProjectionBase & { status: "present"; value: ScalarValue; unit: string | null })
  | (RankAdvisoryProjectionBase & {
    status: Exclude<RankAdvisoryStatus, "present">;
    value?: never;
    unit?: never;
  });

export interface RankedCandidate {
  candidateId: string;
  model: ModelIdentity;
  execution: ExecutionProfile;
  rank: number;
  score: number;
  reasons: RankReason[];
  evidence: RankEvidence[];
  uncertainty: Uncertainty;
}

export interface ExcludedCandidate {
  candidateId: string;
  model: ModelIdentity;
  execution: ExecutionProfile;
  reasons: RankReason[];
  evidence: RankEvidence[];
  uncertainty: Uncertainty;
}

export interface RankedCandidateV2 extends RankedCandidate {
  advisories: RankAdvisoryProjection[];
}

export interface ExcludedCandidateV2 extends ExcludedCandidate {
  advisories: RankAdvisoryProjection[];
}

export interface RankResult {
  schemaVersion: typeof RANK_RESULT_SCHEMA_VERSION;
  catalog: { digest: string; asOf: string };
  task: RankTask;
  scoreScale: { kind: "request-relative"; maximum: number };
  ranked: RankedCandidate[];
  excluded: ExcludedCandidate[];
}

export interface RankResultV2 {
  schemaVersion: typeof RANK_RESULT_SCHEMA_VERSION_V2;
  catalog: { digest: string; asOf: string };
  task: RankTask;
  scoreScale: { kind: "request-relative"; maximum: number };
  ranked: RankedCandidateV2[];
  excluded: ExcludedCandidateV2[];
}

export type AnyRankResult = RankResult | RankResultV2;

/** Source-compatible v1 ranker contract retained for existing implementations. */
export type CatalogRanker = (request: RankRequest) => RankResult;

export interface VersionedCatalogRanker {
  (request: RankRequest): RankResult;
  (request: RankRequestV2): RankResultV2;
  (request: AnyRankRequest): AnyRankResult;
}

type RecordValue = Record<string, unknown>;

const invalid = (path: string, message: string): never => {
  throw new BearingError("INVALID_RANK_REQUEST", path, message);
};

const rankValidated = <T>(operation: () => T): T => {
  try {
    return operation();
  } catch (error) {
    if (error instanceof BearingError && error.code === "INVALID_OBSERVATION") {
      const prefix = `${error.path}: `;
      invalid(error.path, error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message);
    }
    throw error;
  }
};

const record = (value: unknown, path: string): RecordValue => plainRecord(value, path, invalid);

const exactKeys = (value: RecordValue, keys: string[], path: string, requiredKeys = keys): void => {
  allowOnlyKeys(value, keys, path, invalid);
  requireOwnKeys(value, requiredKeys, path, invalid);
};

const array = (value: unknown, path: string, allowEmpty: boolean): unknown[] => plainArray(value, path, allowEmpty, invalid);

const text = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) invalid(path, "must be a non-empty, trimmed string");
  return value as string;
};

const boundedText = (value: unknown, path: string): string => {
  const result = text(value, path);
  if (new TextEncoder().encode(result).byteLength > MAX_RANK_V2_TEXT_BYTES) {
    invalid(path, `must not exceed ${MAX_RANK_V2_TEXT_BYTES} UTF-8 bytes in v2`);
  }
  return result;
};

const assertBoundedStrings = (value: unknown, path: string): void => {
  if (typeof value === "string") {
    boundedText(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertBoundedStrings(item, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) assertBoundedStrings(item, `${path}.${key}`);
  }
};

const scalar = (value: unknown, path: string): ScalarValue => {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    invalid(path, "must be a string, number, or boolean");
  }
  if (typeof value === "number" && !Number.isFinite(value)) invalid(path, "must be finite");
  return value as ScalarValue;
};

const aggregation = (value: unknown, path: string): Aggregation => {
  if (value !== "fact" && value !== "mean" && value !== "min" && value !== "max" && value !== "success-rate" && value !== "count") {
    invalid(path, "must be fact, mean, min, max, success-rate, or count");
  }
  return value as Aggregation;
};

const sourceClasses = (value: unknown, path: string): SourceClass[] | undefined => {
  if (value === undefined) return undefined;
  const result = array(value, path, false).map((item: unknown, index: number) => {
    if (item !== "first-party" && item !== "external") invalid(`${path}[${index}]`, "must be first-party or external");
    return item as SourceClass;
  });
  if (new Set(result).size !== result.length) invalid(path, "must not contain duplicates");
  return result.sort();
};

type RequestText = (value: unknown, path: string) => string;

const validateRankTask = (value: unknown, requestText: RequestText): RankTask => {
  const task = record(value, "$.task");
  exactKeys(task, ["family", "suite"], "$.task");
  return {
    family: requestText(task.family, "$.task.family"),
    suite: task.suite === null ? null : requestText(task.suite, "$.task.suite"),
  };
};

const validateRankInventory = (value: unknown, v2: boolean, requestText: RequestText): RuntimeCandidate[] => {
  const values = array(value, "$.inventory", false);
  if (v2 && values.length > MAX_RANK_V2_CANDIDATES) invalid("$.inventory", `must contain at most ${MAX_RANK_V2_CANDIDATES} candidates in v2`);
  const inventory = values.map((raw, index): RuntimeCandidate => {
    const path = `$.inventory[${index}]`;
    const candidate = record(raw, path);
    exactKeys(candidate, ["id", "model", "execution"], path);
    const execution = rankValidated(() => validateExecutionProfile(candidate.execution, `${path}.execution`));
    if (execution === null) invalid(`${path}.execution`, "must be a concrete execution profile");
    const concreteExecution = execution as ExecutionProfile;
    const normalized = {
      id: requestText(candidate.id, `${path}.id`),
      model: rankValidated(() => validateModelIdentity(candidate.model, `${path}.model`)),
      execution: { ...concreteExecution, toolSurface: [...concreteExecution.toolSurface].sort() },
    };
    if (v2) {
      assertBoundedStrings(normalized.model, `${path}.model`);
      assertBoundedStrings(normalized.execution, `${path}.execution`);
    }
    return normalized;
  });
  if (new Set(inventory.map((candidate) => candidate.id)).size !== inventory.length) invalid("$.inventory", "candidate ids must be unique");
  return inventory.sort((a, b) => compareText(a.id, b.id));
};

const validateRankRequirements = (value: unknown, v2: boolean, requestText: RequestText): RankRequirement[] => {
  const values = array(value, "$.requirements", true);
  if (v2 && values.length > MAX_RANK_V2_CRITERIA) invalid("$.requirements", `must contain at most ${MAX_RANK_V2_CRITERIA} criteria in v2`);
  return values.map((raw, index): RankRequirement => {
    const path = `$.requirements[${index}]`;
    const item = record(raw, path);
    exactKeys(item, ["measurementKey", "aggregation", "operator", "value", "sourceClasses"], path, ["measurementKey", "aggregation", "operator", "value"]);
    if (item.operator !== "eq" && item.operator !== "gte" && item.operator !== "lte") invalid(`${path}.operator`, "must be eq, gte, or lte");
    const requirementValue = scalar(item.value, `${path}.value`);
    if (v2 && typeof requirementValue === "string") boundedText(requirementValue, `${path}.value`);
    if ((item.operator === "gte" || item.operator === "lte") && typeof requirementValue !== "number") invalid(`${path}.value`, "must be numeric for gte or lte");
    return {
      measurementKey: requestText(item.measurementKey, `${path}.measurementKey`),
      aggregation: aggregation(item.aggregation, `${path}.aggregation`),
      operator: item.operator as RankRequirement["operator"],
      value: requirementValue,
      ...(item.sourceClasses === undefined ? {} : { sourceClasses: sourceClasses(item.sourceClasses, `${path}.sourceClasses`) }),
    };
  }).sort((a, b) => compareText(canonicalJson(a), canonicalJson(b)));
};

const validateRankPreferences = (value: unknown, v2: boolean, requestText: RequestText): RankPreference[] => {
  const values = array(value, "$.preferences", true);
  if (v2 && values.length > MAX_RANK_V2_CRITERIA) invalid("$.preferences", `must contain at most ${MAX_RANK_V2_CRITERIA} criteria in v2`);
  return values.map((raw, index): RankPreference => {
    const path = `$.preferences[${index}]`;
    const item = record(raw, path);
    exactKeys(item, ["measurementKey", "aggregation", "direction", "weight", "sourceClasses"], path, ["measurementKey", "aggregation", "direction", "weight"]);
    if (item.direction !== "maximize" && item.direction !== "minimize") invalid(`${path}.direction`, "must be maximize or minimize");
    if (typeof item.weight !== "number" || !Number.isFinite(item.weight) || item.weight <= 0) invalid(`${path}.weight`, "must be a positive finite number");
    return {
      measurementKey: requestText(item.measurementKey, `${path}.measurementKey`),
      aggregation: aggregation(item.aggregation, `${path}.aggregation`),
      direction: item.direction as RankPreference["direction"],
      weight: item.weight as number,
      ...(item.sourceClasses === undefined ? {} : { sourceClasses: sourceClasses(item.sourceClasses, `${path}.sourceClasses`) }),
    };
  }).sort((a, b) => compareText(canonicalJson(a), canonicalJson(b)));
};

const validateRankAdvisories = (value: unknown, inventorySize: number, requestText: RequestText): RankAdvisoryRequest[] => {
  const values = array(value, "$.advisories", true);
  if (values.length > MAX_RANK_V2_ADVISORIES) invalid("$.advisories", `must contain at most ${MAX_RANK_V2_ADVISORIES} advisories`);
  if (inventorySize * values.length > MAX_RANK_V2_ADVISORY_CELLS) invalid("$.advisories", `candidate and advisory count must produce at most ${MAX_RANK_V2_ADVISORY_CELLS} projection cells`);
  const advisories = values.map((raw, index): RankAdvisoryRequest => {
    const path = `$.advisories[${index}]`;
    const item = record(raw, path);
    exactKeys(item, ["id", "measurementKey", "aggregation", "sourceClasses"], path, ["id", "measurementKey", "aggregation"]);
    return {
      id: requestText(item.id, `${path}.id`),
      measurementKey: requestText(item.measurementKey, `${path}.measurementKey`),
      aggregation: aggregation(item.aggregation, `${path}.aggregation`),
      ...(item.sourceClasses === undefined ? {} : { sourceClasses: sourceClasses(item.sourceClasses, `${path}.sourceClasses`) }),
    };
  }).sort((a, b) => compareText(a.id, b.id));
  if (new Set(advisories.map((item) => item.id)).size !== advisories.length) invalid("$.advisories", "advisory ids must be unique");
  return advisories;
};

export function validateRankRequest(value: RankRequest): RankRequest;
export function validateRankRequest(value: RankRequestV2): RankRequestV2;
export function validateRankRequest(value: unknown): AnyRankRequest;
export function validateRankRequest(value: unknown): AnyRankRequest {
  const request = record(value, "$"), v2 = request.schemaVersion === RANK_REQUEST_SCHEMA_VERSION_V2;
  if (request.schemaVersion !== RANK_REQUEST_SCHEMA_VERSION && !v2) invalid("$.schemaVersion", `expected ${RANK_REQUEST_SCHEMA_VERSION} or ${RANK_REQUEST_SCHEMA_VERSION_V2}`);
  exactKeys(request, v2 ? ["schemaVersion", "task", "inventory", "requirements", "preferences", "advisories"] : ["schemaVersion", "task", "inventory", "requirements", "preferences"], "$");
  const requestText = v2 ? boundedText : text;
  const inventory = validateRankInventory(request.inventory, v2, requestText);
  const common = {
    task: validateRankTask(request.task, requestText),
    inventory,
    requirements: validateRankRequirements(request.requirements, v2, requestText),
    preferences: validateRankPreferences(request.preferences, v2, requestText),
  };
  return v2
    ? { schemaVersion: RANK_REQUEST_SCHEMA_VERSION_V2, ...common, advisories: validateRankAdvisories(request.advisories, inventory.length, requestText) }
    : { schemaVersion: RANK_REQUEST_SCHEMA_VERSION, ...common };
}

const uncertaintyOrder: Record<Uncertainty["level"], number> = { low: 0, moderate: 1, high: 2, unknown: 3 };

const combinedUncertainty = (observations: CapabilityObservation[], extraGaps: string[] = []): Uncertainty => {
  if (observations.length === 0) return { level: "unknown", basis: ["no applicable evidence"], gaps: [...new Set(extraGaps)].sort() };
  const level = observations.reduce<Uncertainty["level"]>(
    (current, observation) => uncertaintyOrder[observation.uncertainty.level] > uncertaintyOrder[current]
      ? observation.uncertainty.level
      : current,
    "low",
  );
  return {
    level,
    basis: [...new Set(observations.flatMap((observation) => observation.uncertainty.basis))].sort(),
    gaps: [...new Set([...extraGaps, ...observations.flatMap((observation) => observation.uncertainty.gaps)])].sort(),
  };
};

const taskApplicable = (observation: CapabilityObservation, candidate: RuntimeCandidate, task: RankTask): boolean => {
  if (canonicalJson(observation.model) !== canonicalJson(candidate.model)) return false;
  if (observation.task === null) return true;
  if (observation.task.family !== task.family) return false;
  return task.suite === null || observation.task.suite === task.suite;
};

interface ExecutionScopeEvaluation {
  matches: boolean;
  kind: ObservationExecutionScopeKind;
  asserted: string[];
  wildcarded: string[];
  mismatched: string[];
}

const exactDimensions = ["runtime", "adapter", "effectiveContextTokens", "toolSurface", "hardware", "workflow"];

const evaluateExecutionScope = (
  scope: ExecutionScope | null,
  candidate: ExecutionProfile,
): ExecutionScopeEvaluation => {
  if (scope === null) {
    return { matches: true, kind: "global", asserted: [], wildcarded: ["execution"], mismatched: [] };
  }
  if (scope.kind === "exact") {
    const mismatched = exactDimensions.filter((dimension) =>
      canonicalJson(scope[dimension as keyof ExecutionProfile]) !== canonicalJson(candidate[dimension as keyof ExecutionProfile]));
    return {
      matches: mismatched.length === 0,
      kind: "exact",
      asserted: [...exactDimensions],
      wildcarded: [],
      mismatched,
    };
  }

  const asserted: string[] = [];
  const wildcarded: string[] = [];
  const mismatched: string[] = [];
  const compare = (dimension: string, expected: unknown, actual: unknown): void => {
    asserted.push(dimension);
    if (canonicalJson(expected) !== canonicalJson(actual)) mismatched.push(dimension);
  };
  const optional = (dimension: string, expected: unknown, actual: unknown): void => {
    if (expected === null) wildcarded.push(dimension);
    else compare(dimension, expected, actual);
  };

  compare("runtime.id", scope.runtime.id, candidate.runtime.id);
  optional("runtime.version", scope.runtime.version, candidate.runtime.version);
  if (scope.adapter === null) wildcarded.push("adapter");
  else if (candidate.adapter === null) {
    asserted.push("adapter.id");
    if (scope.adapter.version !== null) asserted.push("adapter.version");
    else wildcarded.push("adapter.version");
    mismatched.push("adapter");
  } else {
    compare("adapter.id", scope.adapter.id, candidate.adapter.id);
    optional("adapter.version", scope.adapter.version, candidate.adapter.version);
  }
  optional("effectiveContextTokens", scope.effectiveContextTokens, candidate.effectiveContextTokens);
  optional("toolSurface", scope.toolSurface, candidate.toolSurface);
  if (scope.hardware === null) wildcarded.push("hardware");
  else if (candidate.hardware === null) {
    asserted.push("hardware.class");
    if (scope.hardware.accelerator === null) wildcarded.push("hardware.accelerator");
    else asserted.push("hardware.accelerator");
    if (scope.hardware.memoryBytes === null) wildcarded.push("hardware.memoryBytes");
    else asserted.push("hardware.memoryBytes");
    mismatched.push("hardware");
  } else {
    compare("hardware.class", scope.hardware.class, candidate.hardware.class);
    optional("hardware.accelerator", scope.hardware.accelerator, candidate.hardware.accelerator);
    optional("hardware.memoryBytes", scope.hardware.memoryBytes, candidate.hardware.memoryBytes);
  }
  if (scope.workflow === null) wildcarded.push("workflow");
  else if (candidate.workflow === null) {
    asserted.push("workflow.id");
    if (scope.workflow.version === null) wildcarded.push("workflow.version");
    else asserted.push("workflow.version");
    if (scope.workflow.condition === null) wildcarded.push("workflow.condition");
    else asserted.push("workflow.condition");
    mismatched.push("workflow");
  } else {
    compare("workflow.id", scope.workflow.id, candidate.workflow.id);
    optional("workflow.version", scope.workflow.version, candidate.workflow.version);
    optional("workflow.condition", scope.workflow.condition, candidate.workflow.condition);
  }
  return { matches: mismatched.length === 0, kind: "partial", asserted, wildcarded, mismatched };
};

const summarizeExecutionApplicability = (evaluations: ExecutionScopeEvaluation[]): ExecutionApplicabilitySummary => ({
  matchedKinds: [...new Set(evaluations.filter((item) => item.matches).map((item) => item.kind))].sort(),
  assertedDimensions: [...new Set(evaluations.flatMap((item) => item.asserted))].sort(),
  wildcardedDimensions: [...new Set(evaluations.flatMap((item) => item.wildcarded))].sort(),
  mismatchedDimensions: [...new Set(evaluations.filter((item) => !item.matches).flatMap((item) => item.mismatched))].sort(),
});

interface AggregateResult {
  status: "ok" | "missing" | "stale" | "conflict" | "incomparable";
  value?: ScalarValue;
  unit?: string | null;
  observations: CapabilityObservation[];
  evidence: RankEvidence;
  /** Includes stale matches for advisory diagnosis without changing v1 ranking evidence. */
  diagnosticObservations: CapabilityObservation[];
  diagnosticEvidence: RankEvidence;
  executionApplicability: ExecutionApplicabilitySummary;
}

const evidenceFor = (measurementKey: string, observations: CapabilityObservation[]): RankEvidence => ({
  measurementKey,
  observationIds: [...new Set(observations.map((observation) => observation.id))].sort(),
  evidenceIds: [...new Set(observations.flatMap((observation) => observation.evidence.map((item) => item.id)))].sort(),
});

const aggregateFor = (
  observations: CapabilityObservation[],
  asOf: string,
  candidate: RuntimeCandidate,
  task: RankTask,
  measurementKey: string,
  mode: Aggregation,
  allowedSources?: SourceClass[],
): AggregateResult => {
  const expectedKind = mode === "fact" ? "fact" : "sample";
  const scoped = observations
    .filter((observation) => taskApplicable(observation, candidate, task))
    .filter((observation) => observation.outcome?.status !== "invalid")
    .filter((observation) => allowedSources === undefined || allowedSources.includes(observation.sourceClass))
    .flatMap((observation) => observation.measurements
      .filter((measurement) => measurement.key === measurementKey)
      .filter((measurement) => measurement.kind === expectedKind)
      .map((measurement) => ({ observation, measurement, scope: evaluateExecutionScope(observation.execution, candidate.execution) })));
  const applicability = summarizeExecutionApplicability(scoped.map((item) => item.scope));
  const matching = scoped.filter(({ scope }) => scope.matches);
  const fresh = matching.filter(({ observation }) => observation.freshness.validUntil === null || observation.freshness.validUntil > asOf);
  const contributingObservations = fresh.map(({ observation }) => observation);
  const matchingObservations = matching.map(({ observation }) => observation);
  const evidence = evidenceFor(measurementKey, contributingObservations);
  const diagnosticObservations = contributingObservations.length > 0
    ? contributingObservations
    : matchingObservations.length > 0 ? matchingObservations : scoped.map(({ observation }) => observation);
  const diagnosticEvidence = evidenceFor(measurementKey, diagnosticObservations);
  if (matching.length === 0 && scoped.length > 0) {
    return { status: "incomparable", observations: [], evidence, diagnosticObservations, diagnosticEvidence, executionApplicability: applicability };
  }
  if (fresh.length === 0) {
    return { status: matching.length > 0 ? "stale" : "missing", observations: [], evidence, diagnosticObservations, diagnosticEvidence, executionApplicability: applicability };
  }
  const values = fresh.map(({ measurement }) => measurement.value);
  const unitSensitive = mode === "fact" || mode === "mean" || mode === "min" || mode === "max";
  const units = new Map(fresh.map(({ measurement }) => [measurement.unit ?? null, measurement.unit ?? null]));
  if (unitSensitive && units.size > 1) {
    return { status: "incomparable", observations: contributingObservations, evidence, diagnosticObservations, diagnosticEvidence, executionApplicability: applicability };
  }
  const unit = unitSensitive ? [...units.values()][0] ?? null : null;
  if (mode === "fact") {
    const unique = new Map(values.map((value) => [canonicalJson(value), value]));
    return unique.size === 1
      ? { status: "ok", value: [...unique.values()][0], unit, observations: contributingObservations, evidence, diagnosticObservations, diagnosticEvidence, executionApplicability: applicability }
      : { status: "conflict", observations: contributingObservations, evidence, diagnosticObservations, diagnosticEvidence, executionApplicability: applicability };
  }
  if (mode === "success-rate") {
    if (!values.every((value) => typeof value === "boolean")) return { status: "incomparable", observations: contributingObservations, evidence, diagnosticObservations, diagnosticEvidence, executionApplicability: applicability };
    return { status: "ok", value: values.filter(Boolean).length / values.length, unit, observations: contributingObservations, evidence, diagnosticObservations, diagnosticEvidence, executionApplicability: applicability };
  }
  if (mode === "count") {
    return { status: "ok", value: values.length, unit, observations: contributingObservations, evidence, diagnosticObservations, diagnosticEvidence, executionApplicability: applicability };
  }
  if (!values.every((value) => typeof value === "number")) return { status: "incomparable", observations: contributingObservations, evidence, diagnosticObservations, diagnosticEvidence, executionApplicability: applicability };
  const numbers = values as number[];
  const value = mode === "mean"
    ? numbers.reduce((sum, current) => sum + current, 0) / numbers.length
    : mode === "min" ? Math.min(...numbers) : Math.max(...numbers);
  return { status: "ok", value, unit, observations: contributingObservations, evidence, diagnosticObservations, diagnosticEvidence, executionApplicability: applicability };
};

const advisoryStatus = (status: AggregateResult["status"]): RankAdvisoryStatus =>
  status === "ok" ? "present" : status === "conflict" ? "conflicting" : status;

const projectAdvisories = (
  observationsFor: (measurementKey: string) => CapabilityObservation[],
  catalog: CatalogSnapshot,
  candidate: RuntimeCandidate,
  task: RankTask,
  requests: RankAdvisoryRequest[],
): RankAdvisoryProjection[] => requests.map((advisory) => {
  const aggregate = aggregateFor(
    observationsFor(advisory.measurementKey),
    catalog.asOf,
    candidate,
    task,
    advisory.measurementKey,
    advisory.aggregation,
    advisory.sourceClasses,
  );
  const status = advisoryStatus(aggregate.status);
  const uncertainty = combinedUncertainty(
    aggregate.diagnosticObservations,
    status === "present" ? [] : [`ADVISORY_${status.toUpperCase()}`],
  );
  const common: RankAdvisoryProjectionBase = {
    id: advisory.id,
    measurementKey: advisory.measurementKey,
    aggregation: advisory.aggregation,
    ...(advisory.sourceClasses === undefined ? {} : { sourceClasses: advisory.sourceClasses }),
    evidence: aggregate.diagnosticEvidence,
    uncertainty,
    executionApplicability: aggregate.executionApplicability,
  };
  return status === "present"
    ? { ...common, status, value: aggregate.value!, unit: aggregate.unit ?? null }
    : { ...common, status };
});

const evidenceReason = (aggregate: AggregateResult, key: string, preference: boolean): RankReason | null => {
  if (aggregate.status === "ok") return null;
  const code: RankReasonCode = aggregate.status === "missing"
    ? (preference ? "PREFERENCE_EVIDENCE_MISSING" : "MISSING_EVIDENCE")
    : aggregate.status === "stale" ? "STALE_EVIDENCE"
      : aggregate.status === "conflict" ? "CONFLICTING_EVIDENCE" : "INCOMPARABLE_EVIDENCE";
  return {
    code,
    measurementKey: key,
    summary: `${aggregate.status} evidence for ${key}`,
    executionApplicability: aggregate.executionApplicability,
  };
};

const requirementMet = (actual: ScalarValue, requirement: RankRequirement): boolean => {
  if (requirement.operator === "eq") return canonicalJson(actual) === canonicalJson(requirement.value);
  if (typeof actual !== "number" || typeof requirement.value !== "number") return false;
  return requirement.operator === "gte" ? actual >= requirement.value : actual <= requirement.value;
};

interface WorkingCandidate {
  candidate: RuntimeCandidate;
  score: number;
  reasons: RankReason[];
  evidence: RankEvidence[];
  observations: CapabilityObservation[];
  preferenceValues: Map<string, number>;
  advisories: RankAdvisoryProjection[];
}

type ObservationsFor = (measurementKey: string) => CapabilityObservation[];

const aggregateCriterion = (
  catalog: CatalogSnapshot,
  candidate: RuntimeCandidate,
  task: RankTask,
  criterion: Pick<RankRequirement, "measurementKey" | "aggregation" | "sourceClasses">,
  observationsFor: ObservationsFor,
): AggregateResult => aggregateFor(
  observationsFor(criterion.measurementKey),
  catalog.asOf,
  candidate,
  task,
  criterion.measurementKey,
  criterion.aggregation,
  criterion.sourceClasses,
);

const createWorkingCandidate = (
  catalog: CatalogSnapshot,
  request: AnyRankRequest,
  candidate: RuntimeCandidate,
  observationsFor: ObservationsFor,
): WorkingCandidate => ({
  candidate,
  score: 0,
  reasons: [],
  evidence: [],
  observations: [],
  preferenceValues: new Map(),
  advisories: request.schemaVersion === RANK_REQUEST_SCHEMA_VERSION_V2
    ? projectAdvisories(observationsFor, catalog, candidate, request.task, request.advisories)
    : [],
});

const evaluateRequirements = (
  working: WorkingCandidate,
  catalog: CatalogSnapshot,
  request: AnyRankRequest,
  observationsFor: ObservationsFor,
): boolean => {
  let failed = false;
  for (const requirement of request.requirements) {
    const aggregate = aggregateCriterion(catalog, working.candidate, request.task, requirement, observationsFor);
    working.evidence.push(aggregate.status === "ok" ? aggregate.evidence : aggregate.diagnosticEvidence);
    working.observations.push(...(aggregate.status === "ok" ? aggregate.observations : aggregate.diagnosticObservations));
    const unavailable = evidenceReason(aggregate, requirement.measurementKey, false);
    if (unavailable !== null) {
      working.reasons.push(unavailable);
      failed = true;
      continue;
    }
    const met = requirementMet(aggregate.value!, requirement);
    working.reasons.push({
      code: met ? "REQUIREMENT_MET" : "REQUIREMENT_NOT_MET",
      measurementKey: requirement.measurementKey,
      summary: `${requirement.measurementKey} ${met ? "satisfied" : "did not satisfy"} ${requirement.operator}`,
      actual: aggregate.value,
      expected: requirement.value,
      executionApplicability: aggregate.executionApplicability,
    });
    if (!met) failed = true;
  }
  return failed;
};

const collectPreferences = (
  working: WorkingCandidate,
  catalog: CatalogSnapshot,
  request: AnyRankRequest,
  observationsFor: ObservationsFor,
): void => {
  for (const preference of request.preferences) {
    const aggregate = aggregateCriterion(catalog, working.candidate, request.task, preference, observationsFor);
    working.evidence.push(aggregate.status === "ok" ? aggregate.evidence : aggregate.diagnosticEvidence);
    working.observations.push(...(aggregate.status === "ok" ? aggregate.observations : aggregate.diagnosticObservations));
    const unavailable = evidenceReason(aggregate, preference.measurementKey, true);
    if (unavailable !== null) working.reasons.push(unavailable);
    else if (typeof aggregate.value === "number") working.preferenceValues.set(canonicalJson(preference), aggregate.value);
    else working.reasons.push({ code: "INCOMPARABLE_EVIDENCE", measurementKey: preference.measurementKey, summary: "preference evidence is not numeric" });
  }
};

const scoreCandidates = (passed: WorkingCandidate[], preferences: RankPreference[]): void => {
  for (const preference of preferences) {
    const key = canonicalJson(preference);
    const values = passed.flatMap((candidate) => candidate.preferenceValues.has(key) ? [candidate.preferenceValues.get(key)!] : []);
    if (values.length === 0) continue;
    const min = Math.min(...values), max = Math.max(...values);
    for (const candidate of passed) {
      const value = candidate.preferenceValues.get(key);
      if (value === undefined) continue;
      const normalized = max === min ? 1 : preference.direction === "maximize" ? (value - min) / (max - min) : (max - value) / (max - min);
      const contribution = normalized * preference.weight;
      candidate.score += contribution;
      candidate.reasons.push({ code: "PREFERENCE_SCORE", measurementKey: preference.measurementKey, summary: `${preference.direction} contributed ${contribution}`, actual: value, contribution });
    }
  }
};

const excludedCandidate = (working: WorkingCandidate, v2: boolean): ExcludedCandidate | ExcludedCandidateV2 => ({
  candidateId: working.candidate.id,
  model: working.candidate.model,
  execution: working.candidate.execution,
  reasons: working.reasons,
  evidence: working.evidence,
  uncertainty: combinedUncertainty(working.observations, working.reasons.map((reason) => reason.code)),
  ...(v2 ? { advisories: working.advisories } : {}),
});

const rankedCandidate = (working: WorkingCandidate, index: number, v2: boolean): RankedCandidate | RankedCandidateV2 => ({
  candidateId: working.candidate.id,
  model: working.candidate.model,
  execution: working.candidate.execution,
  rank: index + 1,
  score: working.score,
  reasons: working.reasons,
  evidence: working.evidence,
  uncertainty: combinedUncertainty(working.observations, working.reasons.filter((reason) => reason.code !== "REQUIREMENT_MET" && reason.code !== "PREFERENCE_SCORE").map((reason) => reason.code)),
  ...(v2 ? { advisories: working.advisories } : {}),
});

const rankValidatedCatalog = (
  catalog: CatalogSnapshot,
  observationsByModelAndMeasurement: Map<string, Map<string, CapabilityObservation[]>>,
  input: AnyRankRequest,
): AnyRankResult => {
  const request = validateRankRequest(input);
  const passed: WorkingCandidate[] = [];
  const excluded: Array<ExcludedCandidate | ExcludedCandidateV2> = [];
  const v2 = request.schemaVersion === RANK_REQUEST_SCHEMA_VERSION_V2;

  for (const candidate of request.inventory) {
    const candidateIndex = observationsByModelAndMeasurement.get(canonicalJson(candidate.model));
    const observationsFor: ObservationsFor = (measurementKey) => candidateIndex?.get(measurementKey) ?? [];
    const working = createWorkingCandidate(catalog, request, candidate, observationsFor);
    if (evaluateRequirements(working, catalog, request, observationsFor)) {
      excluded.push(excludedCandidate(working, v2));
      continue;
    }
    collectPreferences(working, catalog, request, observationsFor);
    passed.push(working);
  }

  scoreCandidates(passed, request.preferences);
  passed.sort((a, b) => b.score - a.score || compareText(a.candidate.id, b.candidate.id));
  excluded.sort((a, b) => compareText(a.candidateId, b.candidateId));
  const common = {
    catalog: { digest: catalog.digest, asOf: catalog.asOf },
    task: request.task,
    scoreScale: {
      kind: "request-relative",
      maximum: request.preferences.reduce((sum, preference) => sum + preference.weight, 0),
    },
    ranked: passed.map((working, index) => rankedCandidate(working, index, v2)),
    excluded,
  };
  return v2
    ? { schemaVersion: RANK_RESULT_SCHEMA_VERSION_V2, ...common } as RankResultV2
    : { schemaVersion: RANK_RESULT_SCHEMA_VERSION, ...common } as RankResult;
};

export const createCatalogRanker = (snapshot: CatalogSnapshot): VersionedCatalogRanker => {
  const catalog = validateCatalogSnapshot(snapshot);
  const observationsByModelAndMeasurement = new Map<string, Map<string, CapabilityObservation[]>>();
  for (const model of catalog.models) {
    const byMeasurement = new Map<string, CapabilityObservation[]>();
    for (const observation of model.observations) {
      for (const key of new Set(observation.measurements.map((measurement) => measurement.key))) {
        const matching = byMeasurement.get(key) ?? [];
        matching.push(observation);
        byMeasurement.set(key, matching);
      }
    }
    observationsByModelAndMeasurement.set(canonicalJson(model.identity), byMeasurement);
  }
  return ((request: AnyRankRequest) => rankValidatedCatalog(catalog, observationsByModelAndMeasurement, request)) as VersionedCatalogRanker;
};

export function rankCatalog(snapshot: CatalogSnapshot, input: RankRequest): RankResult;
export function rankCatalog(snapshot: CatalogSnapshot, input: RankRequestV2): RankResultV2;
export function rankCatalog(snapshot: CatalogSnapshot, input: AnyRankRequest): AnyRankResult;
export function rankCatalog(snapshot: CatalogSnapshot, input: AnyRankRequest): AnyRankResult {
  return (createCatalogRanker(snapshot) as (request: AnyRankRequest) => AnyRankResult)(input);
}
