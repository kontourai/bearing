import { canonicalJson, compareText, sha256 } from "./canonical.js";
import { BearingError } from "./error.js";
import {
  CATALOG_SCHEMA_VERSION,
  type CapabilityObservation,
  type CatalogModel,
  type CatalogSnapshot,
  type CompileCatalogOptions,
  type ConflictSet,
  type ObservationInput,
  type ScalarValue,
} from "./types.js";
import { isoTimestamp, validateObservation } from "./validate.js";

const compareCanonical = (a: unknown, b: unknown): number => compareText(canonicalJson(a), canonicalJson(b));

const compareScalar = (a: ScalarValue, b: ScalarValue): number => {
  const typeOrder = { boolean: 0, number: 1, string: 2 } as const;
  const aType = typeof a as keyof typeof typeOrder;
  const bType = typeof b as keyof typeof typeOrder;
  if (aType !== bType) return typeOrder[aType] - typeOrder[bType];
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return compareText(String(a), String(b));
};

export const normalizeObservation = (input: ObservationInput): CapabilityObservation => {
  const value = validateObservation(input);
  const normalized: ObservationInput = {
    ...value,
    execution: value.execution === null ? null : {
      ...value.execution,
      toolSurface: [...value.execution.toolSurface].sort(),
    },
    measurements: [...value.measurements].sort((a, b) => compareCanonical(a, b)),
    evidence: [...value.evidence].sort((a, b) => compareText(a.id, b.id)),
    uncertainty: {
      ...value.uncertainty,
      basis: [...value.uncertainty.basis].sort(),
      gaps: [...value.uncertainty.gaps].sort(),
    },
  };
  return { ...normalized, id: sha256(normalized) };
};

const modelKey = (observation: CapabilityObservation): string => sha256(observation.model);

interface FactEntry {
  observation: CapabilityObservation;
  modelKey: string;
  measurementKey: string;
  value: ScalarValue;
  scope: string;
}

interface ConflictExtreme {
  value: string;
  endpoint: string;
}

const openEnded = "9999-12-31T23:59:59.999Z";

const updateExtremes = (
  extremes: ConflictExtreme[],
  candidate: ConflictExtreme,
  compareEndpoint: (left: string, right: string) => number,
): ConflictExtreme[] => {
  const updated = extremes.filter((entry) => entry.value !== candidate.value);
  const existing = extremes.find((entry) => entry.value === candidate.value);
  updated.push(existing !== undefined && compareEndpoint(existing.endpoint, candidate.endpoint) <= 0 ? existing : candidate);
  return updated
    .sort((left, right) => compareEndpoint(left.endpoint, right.endpoint) || compareText(left.value, right.value))
    .slice(0, 2);
};

// Each participant sees a different value ending after its start or starting before its end.
// Keeping the best two endpoints from distinct values makes that exclusion query constant-time.
const conflictingParticipants = (entries: FactEntry[]): Set<string> => {
  const sorted = [...entries].sort((left, right) =>
    compareText(left.observation.freshness.observedAt, right.observation.freshness.observedAt)
    || compareText(left.observation.id, right.observation.id));
  const participants = new Set<string>();
  let latestEnds: ConflictExtreme[] = [];
  for (const entry of sorted) {
    const value = canonicalJson(entry.value);
    const other = latestEnds.find((candidate) => candidate.value !== value);
    if (other !== undefined && other.endpoint > entry.observation.freshness.observedAt) {
      participants.add(entry.observation.id);
    }
    latestEnds = updateExtremes(
      latestEnds,
      { value, endpoint: entry.observation.freshness.validUntil ?? openEnded },
      (left, right) => compareText(right, left),
    );
  }

  let earliestStarts: ConflictExtreme[] = [];
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const entry = sorted[index];
    const value = canonicalJson(entry.value);
    const other = earliestStarts.find((candidate) => candidate.value !== value);
    if (other !== undefined && other.endpoint < (entry.observation.freshness.validUntil ?? openEnded)) {
      participants.add(entry.observation.id);
    }
    earliestStarts = updateExtremes(
      earliestStarts,
      { value, endpoint: entry.observation.freshness.observedAt },
      compareText,
    );
  }
  return participants;
};

const conflictsFor = (observations: CapabilityObservation[]): ConflictSet[] => {
  const groups = new Map<string, FactEntry[]>();
  for (const observation of observations) {
    const key = modelKey(observation);
    for (const measurement of observation.measurements) {
      if (measurement.kind !== "fact") continue;
      const scope = sha256({ model: observation.model, execution: observation.execution, task: observation.task, measurementKey: measurement.key });
      const entries = groups.get(scope) ?? [];
      entries.push({ observation, modelKey: key, measurementKey: measurement.key, value: measurement.value, scope });
      groups.set(scope, entries);
    }
  }

  const conflicts: ConflictSet[] = [];
  for (const entries of groups.values()) {
    const participantIds = conflictingParticipants(entries);
    if (participantIds.size === 0) continue;
    const participants = entries.filter((entry) => participantIds.has(entry.observation.id));
    const values = [...new Map(participants.map((entry) => [canonicalJson(entry.value), entry.value])).values()]
      .sort(compareScalar);
    const first = participants[0];
    conflicts.push({
      key: first.scope,
      modelKey: first.modelKey,
      measurementKey: first.measurementKey,
      execution: first.observation.execution,
      task: first.observation.task,
      observationIds: [...participantIds].sort(),
      values,
    });
  }
  return conflicts.sort((a, b) => compareText(a.key, b.key));
};

export const compileCatalog = (inputs: ObservationInput[], options: CompileCatalogOptions): CatalogSnapshot => {
  let asOf: string;
  try {
    asOf = isoTimestamp(options?.asOf, "$.asOf");
  } catch (error) {
    if (error instanceof BearingError) {
      throw new BearingError("INVALID_COMPILE_OPTIONS", error.path, error.message.replace(/^\$\.asOf: /, ""));
    }
    throw error;
  }
  const observations = inputs.map(normalizeObservation);
  observations.forEach((observation, index) => {
    if (observation.freshness.observedAt > asOf) {
      throw new BearingError(
        "INVALID_COMPILE_OPTIONS",
        `$.observations[${index}].freshness.observedAt`,
        `observation occurs after catalog asOf ${asOf}`,
      );
    }
    observation.evidence.forEach((evidence, evidenceIndex) => {
      if (evidence.observedAt > asOf) {
        throw new BearingError(
          "INVALID_COMPILE_OPTIONS",
          `$.observations[${index}].evidence[${evidenceIndex}].observedAt`,
          `evidence occurs after catalog asOf ${asOf}`,
        );
      }
    });
  });
  const ids = new Set<string>();
  for (const observation of observations) {
    if (ids.has(observation.id)) {
      throw new BearingError("DUPLICATE_OBSERVATION", "$.observations", `duplicate normalized observation ${observation.id}`);
    }
    ids.add(observation.id);
  }

  const grouped = new Map<string, CatalogModel>();
  for (const observation of observations) {
    const key = modelKey(observation);
    const entry = grouped.get(key) ?? { key, identity: observation.model, observations: [] };
    entry.observations.push(observation);
    grouped.set(key, entry);
  }
  const models = [...grouped.values()]
    .map((entry) => ({ ...entry, observations: entry.observations.sort((a, b) => compareText(a.id, b.id)) }))
    .sort((a, b) => compareText(a.key, b.key));
  const conflicts = conflictsFor(observations);
  const content = { schemaVersion: CATALOG_SCHEMA_VERSION, asOf, models, conflicts };
  return { ...content, digest: sha256(content) };
};
