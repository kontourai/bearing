import { canonicalJson, compareText } from "./canonical.js";
import { BearingError } from "./error.js";
import type {
  CapabilityObservation,
  CatalogSnapshot,
  ExecutionProfile,
  ModelIdentity,
  ScalarValue,
  SourceClass,
  Uncertainty,
} from "./types.js";
import { validateCatalogSnapshot } from "./snapshot.js";
import { validateExecutionProfile, validateModelIdentity } from "./validate.js";

export const RANK_REQUEST_SCHEMA_VERSION = "bearing.rank.request/v1" as const;
export const RANK_RESULT_SCHEMA_VERSION = "bearing.rank.result/v1" as const;

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

export interface RankRequest {
  schemaVersion: typeof RANK_REQUEST_SCHEMA_VERSION;
  task: RankTask;
  inventory: RuntimeCandidate[];
  requirements: RankRequirement[];
  preferences: RankPreference[];
}

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
}

export interface RankEvidence {
  measurementKey: string;
  observationIds: string[];
  evidenceIds: string[];
}

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

export interface RankResult {
  schemaVersion: typeof RANK_RESULT_SCHEMA_VERSION;
  catalog: { digest: string; asOf: string };
  task: RankTask;
  scoreScale: { kind: "request-relative"; maximum: number };
  ranked: RankedCandidate[];
  excluded: ExcludedCandidate[];
}

export type CatalogRanker = (request: RankRequest) => RankResult;

type RecordValue = Record<string, unknown>;

const invalid = (path: string, message: string): never => {
  throw new BearingError("INVALID_RANK_REQUEST", path, message);
};

const record = (value: unknown, path: string): RecordValue => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(path, "must be an object");
  return value as RecordValue;
};

const exactKeys = (value: RecordValue, keys: string[], path: string, requiredKeys = keys): void => {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) if (!expected.has(key)) invalid(`${path}.${key}`, "is not supported");
  for (const key of requiredKeys) if (!(key in value)) invalid(`${path}.${key}`, "is required");
};

const text = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) invalid(path, "must be a non-empty, trimmed string");
  return value as string;
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
  if (!Array.isArray(value) || value.length === 0) invalid(path, "must be a non-empty array");
  const result = (value as unknown[]).map((item: unknown, index: number) => {
    if (item !== "first-party" && item !== "external") invalid(`${path}[${index}]`, "must be first-party or external");
    return item as SourceClass;
  });
  if (new Set(result).size !== result.length) invalid(path, "must not contain duplicates");
  return result.sort();
};

export const validateRankRequest = (value: unknown): RankRequest => {
  const request = record(value, "$");
  exactKeys(request, ["schemaVersion", "task", "inventory", "requirements", "preferences"], "$");
  if (request.schemaVersion !== RANK_REQUEST_SCHEMA_VERSION) invalid("$.schemaVersion", `expected ${RANK_REQUEST_SCHEMA_VERSION}`);
  const taskValue = record(request.task, "$.task");
  exactKeys(taskValue, ["family", "suite"], "$.task");
  const task: RankTask = {
    family: text(taskValue.family, "$.task.family"),
    suite: taskValue.suite === null ? null : text(taskValue.suite, "$.task.suite"),
  };

  if (!Array.isArray(request.inventory) || request.inventory.length === 0) invalid("$.inventory", "must be a non-empty array");
  const inventory = (request.inventory as unknown[]).map((raw, index): RuntimeCandidate => {
    const path = `$.inventory[${index}]`;
    const candidate = record(raw, path);
    exactKeys(candidate, ["id", "model", "execution"], path);
    const execution = validateExecutionProfile(candidate.execution, `${path}.execution`);
    if (execution === null) invalid(`${path}.execution`, "must be a concrete execution profile");
    return {
      id: text(candidate.id, `${path}.id`),
      model: validateModelIdentity(candidate.model, `${path}.model`),
      execution: { ...(execution as ExecutionProfile), toolSurface: [...(execution as ExecutionProfile).toolSurface].sort() },
    };
  });
  if (new Set(inventory.map((candidate) => candidate.id)).size !== inventory.length) invalid("$.inventory", "candidate ids must be unique");

  if (!Array.isArray(request.requirements)) invalid("$.requirements", "must be an array");
  const requirements = (request.requirements as unknown[]).map((raw, index): RankRequirement => {
    const path = `$.requirements[${index}]`;
    const item = record(raw, path);
    exactKeys(
      item,
      ["measurementKey", "aggregation", "operator", "value", "sourceClasses"],
      path,
      ["measurementKey", "aggregation", "operator", "value"],
    );
    if (item.operator !== "eq" && item.operator !== "gte" && item.operator !== "lte") invalid(`${path}.operator`, "must be eq, gte, or lte");
    const value = scalar(item.value, `${path}.value`);
    if ((item.operator === "gte" || item.operator === "lte") && typeof value !== "number") invalid(`${path}.value`, "must be numeric for gte or lte");
    return {
      measurementKey: text(item.measurementKey, `${path}.measurementKey`),
      aggregation: aggregation(item.aggregation, `${path}.aggregation`),
      operator: item.operator as RankRequirement["operator"],
      value,
      ...(item.sourceClasses === undefined ? {} : { sourceClasses: sourceClasses(item.sourceClasses, `${path}.sourceClasses`) }),
    };
  }).sort((a, b) => compareText(canonicalJson(a), canonicalJson(b)));

  if (!Array.isArray(request.preferences)) invalid("$.preferences", "must be an array");
  const preferences = (request.preferences as unknown[]).map((raw, index): RankPreference => {
    const path = `$.preferences[${index}]`;
    const item = record(raw, path);
    exactKeys(
      item,
      ["measurementKey", "aggregation", "direction", "weight", "sourceClasses"],
      path,
      ["measurementKey", "aggregation", "direction", "weight"],
    );
    if (item.direction !== "maximize" && item.direction !== "minimize") invalid(`${path}.direction`, "must be maximize or minimize");
    if (typeof item.weight !== "number" || !Number.isFinite(item.weight) || item.weight <= 0) invalid(`${path}.weight`, "must be a positive finite number");
    return {
      measurementKey: text(item.measurementKey, `${path}.measurementKey`),
      aggregation: aggregation(item.aggregation, `${path}.aggregation`),
      direction: item.direction as RankPreference["direction"],
      weight: item.weight as number,
      ...(item.sourceClasses === undefined ? {} : { sourceClasses: sourceClasses(item.sourceClasses, `${path}.sourceClasses`) }),
    };
  }).sort((a, b) => compareText(canonicalJson(a), canonicalJson(b)));

  return {
    schemaVersion: RANK_REQUEST_SCHEMA_VERSION,
    task,
    inventory: [...inventory].sort((a, b) => compareText(a.id, b.id)),
    requirements,
    preferences,
  };
};

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

const applicable = (observation: CapabilityObservation, candidate: RuntimeCandidate, task: RankTask): boolean => {
  if (canonicalJson(observation.model) !== canonicalJson(candidate.model)) return false;
  if (observation.execution !== null && canonicalJson(observation.execution) !== canonicalJson(candidate.execution)) return false;
  if (observation.task === null) return true;
  if (observation.task.family !== task.family) return false;
  return task.suite === null || observation.task.suite === task.suite;
};

interface AggregateResult {
  status: "ok" | "missing" | "stale" | "conflict" | "incomparable";
  value?: ScalarValue;
  observations: CapabilityObservation[];
  evidence: RankEvidence;
}

const aggregateFor = (
  observations: CapabilityObservation[],
  asOf: string,
  candidate: RuntimeCandidate,
  task: RankTask,
  measurementKey: string,
  mode: Aggregation,
  allowedSources?: SourceClass[],
): AggregateResult => {
  const all = observations
    .filter((observation) => applicable(observation, candidate, task))
    .filter((observation) => observation.outcome?.status !== "invalid")
    .filter((observation) => allowedSources === undefined || allowedSources.includes(observation.sourceClass))
    .flatMap((observation) => observation.measurements
      .filter((measurement) => measurement.key === measurementKey)
      .map((measurement) => ({ observation, measurement })));
  const expectedKind = mode === "fact" ? "fact" : "sample";
  const matching = all.filter(({ measurement }) => measurement.kind === expectedKind);
  const fresh = matching.filter(({ observation }) => observation.freshness.validUntil === null || observation.freshness.validUntil > asOf);
  const contributingObservations = fresh.map(({ observation }) => observation);
  const evidence: RankEvidence = {
    measurementKey,
    observationIds: [...new Set(contributingObservations.map((observation) => observation.id))].sort(),
    evidenceIds: [...new Set(contributingObservations.flatMap((observation) => observation.evidence.map((item) => item.id)))].sort(),
  };
  if (fresh.length === 0) {
    return { status: matching.length > 0 ? "stale" : "missing", observations: [], evidence };
  }
  const values = fresh.map(({ measurement }) => measurement.value);
  if (mode === "fact") {
    const unique = new Map(values.map((value) => [canonicalJson(value), value]));
    return unique.size === 1
      ? { status: "ok", value: [...unique.values()][0], observations: contributingObservations, evidence }
      : { status: "conflict", observations: contributingObservations, evidence };
  }
  if (mode === "success-rate") {
    if (!values.every((value) => typeof value === "boolean")) return { status: "incomparable", observations: contributingObservations, evidence };
    return { status: "ok", value: values.filter(Boolean).length / values.length, observations: contributingObservations, evidence };
  }
  if (mode === "count") {
    return { status: "ok", value: values.length, observations: contributingObservations, evidence };
  }
  if (!values.every((value) => typeof value === "number")) return { status: "incomparable", observations: contributingObservations, evidence };
  const numbers = values as number[];
  const value = mode === "mean"
    ? numbers.reduce((sum, current) => sum + current, 0) / numbers.length
    : mode === "min" ? Math.min(...numbers) : Math.max(...numbers);
  return { status: "ok", value, observations: contributingObservations, evidence };
};

const evidenceReason = (aggregate: AggregateResult, key: string, preference: boolean): RankReason | null => {
  if (aggregate.status === "ok") return null;
  const code: RankReasonCode = aggregate.status === "missing"
    ? (preference ? "PREFERENCE_EVIDENCE_MISSING" : "MISSING_EVIDENCE")
    : aggregate.status === "stale" ? "STALE_EVIDENCE"
      : aggregate.status === "conflict" ? "CONFLICTING_EVIDENCE" : "INCOMPARABLE_EVIDENCE";
  return { code, measurementKey: key, summary: `${aggregate.status} evidence for ${key}` };
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
}

const rankValidatedCatalog = (
  catalog: CatalogSnapshot,
  observationsByModel: Map<string, CapabilityObservation[]>,
  input: RankRequest,
): RankResult => {
  const request = validateRankRequest(input);
  const passed: WorkingCandidate[] = [];
  const excluded: ExcludedCandidate[] = [];

  for (const candidate of request.inventory) {
    const candidateObservations = observationsByModel.get(canonicalJson(candidate.model)) ?? [];
    const working: WorkingCandidate = { candidate, score: 0, reasons: [], evidence: [], observations: [], preferenceValues: new Map() };
    let failed = false;
    for (const requirement of request.requirements) {
      const aggregate = aggregateFor(
        candidateObservations,
        catalog.asOf,
        candidate,
        request.task,
        requirement.measurementKey,
        requirement.aggregation,
        requirement.sourceClasses,
      );
      working.evidence.push(aggregate.evidence);
      working.observations.push(...aggregate.observations);
      const unavailable = evidenceReason(aggregate, requirement.measurementKey, false);
      if (unavailable !== null) {
        working.reasons.push(unavailable);
        failed = true;
        continue;
      }
      if (!requirementMet(aggregate.value!, requirement)) {
        working.reasons.push({
          code: "REQUIREMENT_NOT_MET",
          measurementKey: requirement.measurementKey,
          summary: `${requirement.measurementKey} did not satisfy ${requirement.operator}`,
          actual: aggregate.value,
          expected: requirement.value,
        });
        failed = true;
      } else {
        working.reasons.push({
          code: "REQUIREMENT_MET",
          measurementKey: requirement.measurementKey,
          summary: `${requirement.measurementKey} satisfied ${requirement.operator}`,
          actual: aggregate.value,
          expected: requirement.value,
        });
      }
    }
    if (failed) {
      excluded.push({
        candidateId: candidate.id,
        model: candidate.model,
        execution: candidate.execution,
        reasons: working.reasons,
        evidence: working.evidence,
        uncertainty: combinedUncertainty(working.observations, working.reasons.map((reason) => reason.code)),
      });
      continue;
    }
    for (const preference of request.preferences) {
      const aggregate = aggregateFor(
        candidateObservations,
        catalog.asOf,
        candidate,
        request.task,
        preference.measurementKey,
        preference.aggregation,
        preference.sourceClasses,
      );
      working.evidence.push(aggregate.evidence);
      working.observations.push(...aggregate.observations);
      const unavailable = evidenceReason(aggregate, preference.measurementKey, true);
      if (unavailable !== null) working.reasons.push(unavailable);
      else if (typeof aggregate.value === "number") working.preferenceValues.set(canonicalJson(preference), aggregate.value);
      else working.reasons.push({ code: "INCOMPARABLE_EVIDENCE", measurementKey: preference.measurementKey, summary: "preference evidence is not numeric" });
    }
    passed.push(working);
  }

  for (const preference of request.preferences) {
    const key = canonicalJson(preference);
    const values = passed.flatMap((candidate) => candidate.preferenceValues.has(key) ? [candidate.preferenceValues.get(key)!] : []);
    if (values.length === 0) continue;
    const min = Math.min(...values);
    const max = Math.max(...values);
    for (const candidate of passed) {
      const value = candidate.preferenceValues.get(key);
      if (value === undefined) continue;
      const normalized = max === min ? 1 : preference.direction === "maximize"
        ? (value - min) / (max - min)
        : (max - value) / (max - min);
      const contribution = normalized * preference.weight;
      candidate.score += contribution;
      candidate.reasons.push({
        code: "PREFERENCE_SCORE",
        measurementKey: preference.measurementKey,
        summary: `${preference.direction} contributed ${contribution}`,
        actual: value,
        contribution,
      });
    }
  }

  passed.sort((a, b) => b.score - a.score || compareText(a.candidate.id, b.candidate.id));
  excluded.sort((a, b) => compareText(a.candidateId, b.candidateId));
  return {
    schemaVersion: RANK_RESULT_SCHEMA_VERSION,
    catalog: { digest: catalog.digest, asOf: catalog.asOf },
    task: request.task,
    scoreScale: {
      kind: "request-relative",
      maximum: request.preferences.reduce((sum, preference) => sum + preference.weight, 0),
    },
    ranked: passed.map((working, index) => ({
      candidateId: working.candidate.id,
      model: working.candidate.model,
      execution: working.candidate.execution,
      rank: index + 1,
      score: working.score,
      reasons: working.reasons,
      evidence: working.evidence,
      uncertainty: combinedUncertainty(working.observations, working.reasons.filter((reason) => reason.code !== "REQUIREMENT_MET" && reason.code !== "PREFERENCE_SCORE").map((reason) => reason.code)),
    })),
    excluded,
  };
};

export const createCatalogRanker = (snapshot: CatalogSnapshot): CatalogRanker => {
  const catalog = validateCatalogSnapshot(snapshot);
  const observationsByModel = new Map<string, CapabilityObservation[]>();
  for (const model of catalog.models) observationsByModel.set(canonicalJson(model.identity), model.observations);
  return (request) => rankValidatedCatalog(catalog, observationsByModel, request);
};

export const rankCatalog = (snapshot: CatalogSnapshot, input: RankRequest): RankResult =>
  createCatalogRanker(snapshot)(input);
