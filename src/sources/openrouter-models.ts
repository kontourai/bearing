import {
  buildSnapshotSourceRef,
  parseSnapshotSourceRef,
  type SnapshotSourceRefResolution,
} from "@kontourai/forage/fetch";
import { compareText, sha256 } from "../canonical.js";
import { BearingError } from "../error.js";
import {
  isDefaultApprovedSourceIdentity,
  isParsedApprovedSourceManifest,
  type ApprovedSource,
  type ApprovedSourceManifest,
} from "../trusted-sources/manifest.js";
import {
  OBSERVATION_SCHEMA_VERSION,
  type ModelIdentity,
  type ObservationInput,
} from "../types.js";
import { validateModelIdentity, validateObservation } from "../validate.js";
import {
  OPENROUTER_MAX_ROWS,
  parseOpenRouterModelRows,
  type ParsedOpenRouterModelRow,
} from "./openrouter-models-parser.js";

const MAX_SOURCE_REF_LENGTH = 16 * 1024;
const MAX_OBSERVATIONS = 10_000;
const MAX_NORMALIZED_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_MAPPING_KEY_CHARACTERS = 512;
const MAX_MAPPING_IDENTITY_BYTES = 1_024;
const ESTIMATED_FIXED_OBSERVATION_BYTES = 4_096;

export const OPENROUTER_MODELS_SOURCE = Object.freeze({
  id: "openrouter-models",
  owner: "OpenRouter",
  canonicalOrigin: "https://openrouter.ai",
  url: "https://openrouter.ai/api/v1/models",
  mediaType: "application/json",
  maxBytes: 8 * 1024 * 1024,
  attributionUrl: "https://openrouter.ai/docs/api/reference/models/get-models",
  artificialAnalysisUrl: "https://artificialanalysis.ai/",
  designArenaUrl: "https://www.designarena.ai/",
  license: "NOASSERTION",
  sourceClass: "external" as const,
});

export type OpenRouterTrustedSnapshot = Extract<SnapshotSourceRefResolution, { ok: true }>;

export interface OpenRouterModelMapping {
  model: ModelIdentity;
  validUntil: string | null;
}

export interface OpenRouterModelsImportInput {
  manifest: ApprovedSourceManifest;
  sourceId: string;
  snapshot: OpenRouterTrustedSnapshot;
  /** Exact OpenRouter row id to reviewed model identity. */
  models: Readonly<Record<string, OpenRouterModelMapping>>;
}

export interface OpenRouterModelsDiagnostic {
  code: "unmapped-model" | "configured-model-missing";
  path: string;
  message: string;
}

export interface OpenRouterModelsImportResult {
  observations: ObservationInput[];
  diagnostics: OpenRouterModelsDiagnostic[];
  acquisition: {
    sourceId: string;
    sourceRef: string;
    sourceUrl: string;
    bodySha256: string;
    fetchedAt: string;
    rowCount: number;
    manifestDigest: string;
    revision: string;
  };
}

const fail = (path: string, message: string): never => {
  throw new BearingError("INVALID_SOURCE_SNAPSHOT", path, message);
};

const record = (value: unknown, path: string): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : fail(path, "must be an object");

const exactKeys = (value: Record<string, unknown>, keys: readonly string[], path: string): void => {
  const actual = Object.keys(value).sort(compareText);
  const expected = [...keys].sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    return fail(path, `must contain exactly: ${expected.join(", ")}`);
  }
};

const isoTimestamp = (value: unknown, path: string): string => {
  if (typeof value !== "string") return fail(path, "must be an ISO-8601 UTC timestamp");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    return fail(path, "must be an ISO-8601 UTC timestamp");
  }
  return value;
};

const approvedSource = (manifest: ApprovedSourceManifest, sourceId: string): ApprovedSource => {
  if (!isParsedApprovedSourceManifest(manifest)) return fail("$.manifest", "must be a parsed approved source manifest");
  if (sourceId !== OPENROUTER_MODELS_SOURCE.id) return fail("$.sourceId", "must identify the approved OpenRouter models source");
  const source = manifest.sources.find((candidate) => candidate.id === sourceId);
  if (source === undefined) return fail("$.sourceId", "is not present in the approved source manifest");
  if (!isDefaultApprovedSourceIdentity(source)) {
    return fail("$.manifest", "source must use the approved official OpenRouter source identity");
  }
  return source;
};

const validateSnapshotEnvelope = (resolution: OpenRouterTrustedSnapshot): string => {
  if (resolution === null || typeof resolution !== "object" || resolution.ok !== true) {
    return fail("$.snapshot", "must be a successful exact snapshot resolution");
  }
  if (resolution.integrity !== "snapshot-envelope") return fail("$.snapshot.integrity", "must cite a full snapshot envelope");
  let sourceRef: string;
  try {
    sourceRef = buildSnapshotSourceRef(resolution.snapshot);
  } catch {
    return fail("$.snapshot", "must contain a valid canonical durable snapshot");
  }
  if (sourceRef.length > MAX_SOURCE_REF_LENGTH) return fail("$.snapshot.reference", "exceeds the source reference bound");
  const expectedReference = parseSnapshotSourceRef(sourceRef)!;
  if (
    resolution.reference === null || typeof resolution.reference !== "object" ||
    resolution.reference.sourceId !== expectedReference.sourceId ||
    resolution.reference.url !== expectedReference.url ||
    resolution.reference.bodyHash !== expectedReference.bodyHash ||
    resolution.reference.fetchedAt !== expectedReference.fetchedAt ||
    resolution.reference.snapshotDigest !== expectedReference.snapshotDigest
  ) {
    return fail("$.snapshot.reference", "must exactly match the recomputed snapshot envelope");
  }
  return sourceRef;
};

const decodeSnapshotBody = (resolution: OpenRouterTrustedSnapshot, source: ApprovedSource): string => {
  if (resolution === null || typeof resolution !== "object" || resolution.ok !== true) {
    return fail("$.snapshot", "must be a successful exact snapshot resolution");
  }
  if (
    resolution.snapshot.sourceId !== source.resolver.entrypoint.sourceId ||
    resolution.snapshot.url !== source.resolver.entrypoint.url ||
    resolution.snapshot.status !== 200
  ) {
    return fail("$.snapshot", "must bind the official OpenRouter models endpoint and a successful response");
  }
  const bytes = typeof resolution.snapshot.body === "string"
    ? Buffer.from(resolution.snapshot.body, "utf8")
    : resolution.snapshot.body;
  if (bytes.byteLength > source.resolver.entrypoint.maxBytes || bytes.byteLength > source.resolver.maxBytes) {
    return fail("$.snapshot.body", "exceeds the approved source byte limit");
  }
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (typeof resolution.snapshot.body === "string" && body !== resolution.snapshot.body) {
      return fail("$.snapshot.body", "must round-trip through exact UTF-8 bytes");
    }
  } catch {
    return fail("$.snapshot.body", "must be valid UTF-8");
  }
  const contentType = Object.entries(resolution.snapshot.headers ?? {})
    .find(([name]) => name.toLowerCase() === "content-type")?.[1]
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== source.resolver.entrypoint.mediaType) {
    return fail("$.snapshot.headers.content-type", `must be ${source.resolver.entrypoint.mediaType}`);
  }
  return body;
};

const validateSnapshot = (
  resolution: OpenRouterTrustedSnapshot,
  source: ApprovedSource,
): { body: string; sourceRef: string; fetchedAt: string; bodyHash: string } => {
  const sourceRef = validateSnapshotEnvelope(resolution);
  const body = decodeSnapshotBody(resolution, source);
  return {
    body,
    sourceRef,
    fetchedAt: isoTimestamp(resolution.snapshot.fetchedAt, "$.snapshot.fetchedAt"),
    bodyHash: resolution.snapshot.bodyHash,
  };
};

const validateMapping = (value: unknown, modelId: string): OpenRouterModelMapping => {
  const item = record(value, `$.models.${modelId}`);
  exactKeys(item, ["model", "validUntil"], `$.models.${modelId}`);
  const model = validateModelIdentity(item.model, `$.models.${modelId}.model`);
  for (const [field, text] of Object.entries(model)) {
    if (text !== null && Buffer.byteLength(text, "utf8") > MAX_MAPPING_IDENTITY_BYTES) {
      return fail(`$.models.${modelId}.model.${field}`, `must be at most ${MAX_MAPPING_IDENTITY_BYTES} UTF-8 bytes`);
    }
  }
  return {
    model,
    validUntil: item.validUntil === null ? null : isoTimestamp(item.validUntil, `$.models.${modelId}.validUntil`),
  };
};

const validateMappings = (value: unknown): ReadonlyMap<string, OpenRouterModelMapping> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("$.models", "must be an exact model-row mapping");
  }
  const entries = Object.entries(value);
  if (entries.length > OPENROUTER_MAX_ROWS) return fail("$.models", `must contain at most ${OPENROUTER_MAX_ROWS} mappings`);
  const mappings = new Map<string, OpenRouterModelMapping>();
  for (const [rowId, mapping] of entries) {
    if (rowId.length === 0 || rowId.length > MAX_MAPPING_KEY_CHARACTERS || rowId.trim() !== rowId) {
      return fail(`$.models.${rowId}`, `key must be a trimmed identity of at most ${MAX_MAPPING_KEY_CHARACTERS} characters`);
    }
    try { encodeURIComponent(rowId); } catch { return fail(`$.models.${rowId}`, "key must be URI-encodable Unicode text"); }
    mappings.set(rowId, validateMapping(mapping, rowId));
  }
  return mappings;
};

const earlier = (left: string | null, right: string): string =>
  left === null || right < left ? right : left;

const mappingEvidence = (rowId: string, mapping: OpenRouterModelMapping, fetchedAt: string) => {
  const mappingDigest = sha256({ row: rowId, mapping });
  return {
    id: `openrouter-model-mapping:${mappingDigest}`,
    kind: "model-mapping",
    uri: `urn:bearing:openrouter-model-mapping:${encodeURIComponent(rowId)}:sha256:${mappingDigest}`,
    digest: { algorithm: "sha256" as const, value: mappingDigest },
    observedAt: fetchedAt,
  };
};

const valueEvidence = (rowId: string, kind: string, value: unknown, fetchedAt: string) => {
  const digest = sha256({ row: rowId, kind, value });
  return {
    id: `${kind}:${digest}`,
    kind: "structured-field",
    uri: `urn:bearing:openrouter-model-field:${encodeURIComponent(rowId)}:${encodeURIComponent(kind)}:sha256:${digest}`,
    digest: { algorithm: "sha256" as const, value: digest },
    observedAt: fetchedAt,
  };
};

const attributionEvidence = (id: string, uri: string, fetchedAt: string) => ({
  id: `${id}-attribution`,
  kind: "benchmark-attribution",
  uri,
  digest: null,
  observedAt: fetchedAt,
});

const factMeasurements = (row: ParsedOpenRouterModelRow): ObservationInput["measurements"] => {
  const measurements: ObservationInput["measurements"] = [
    { key: "openrouter.model.context.max_tokens", kind: "fact", value: row.contextLength, unit: "tokens" },
    { key: "openrouter.input.image", kind: "fact", value: row.inputModalities.includes("image") },
    { key: "openrouter.input.file", kind: "fact", value: row.inputModalities.includes("file") },
    { key: "openrouter.tool_calling", kind: "fact", value: row.supportedParameters.includes("tools") },
    { key: "openrouter.structured_outputs", kind: "fact", value: row.supportedParameters.includes("structured_outputs") },
  ];
  if (row.topProviderContextLength !== null) measurements.push({ key: "openrouter.top_provider.context.max_tokens", kind: "fact", value: row.topProviderContextLength, unit: "tokens" });
  if (row.promptPrice !== null) measurements.push({ key: "openrouter.price.prompt_usd_per_token", kind: "fact", value: row.promptPrice, unit: "USD/token" });
  if (row.completionPrice !== null) measurements.push({ key: "openrouter.price.completion_usd_per_token", kind: "fact", value: row.completionPrice, unit: "USD/token" });
  if (row.maxCompletionTokens !== null) measurements.push({ key: "openrouter.completion.max_tokens", kind: "fact", value: row.maxCompletionTokens, unit: "tokens" });
  if (row.reasoning !== null) {
    measurements.push({ key: "openrouter.reasoning.mandatory", kind: "fact", value: row.reasoning.mandatory });
    if (row.reasoning.defaultEnabled !== null) measurements.push({ key: "openrouter.reasoning.default_enabled", kind: "fact", value: row.reasoning.defaultEnabled });
    measurements.push(...row.reasoning.supportedEfforts.map((effort) => ({ key: `openrouter.reasoning.effort.${effort}`, kind: "fact" as const, value: true })));
  }
  return measurements;
};

const factObservation = (
  row: ParsedOpenRouterModelRow,
  mapping: OpenRouterModelMapping,
  measurement: ObservationInput["measurements"][number],
  fetchedAt: string,
  validUntil: string,
): ObservationInput => validateObservation({
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    kind: "declaration",
    model: mapping.model,
    execution: {
      kind: "partial",
      runtime: { id: "openrouter", version: null },
      adapter: null,
      effectiveContextTokens: null,
      toolSurface: null,
      hardware: null,
      workflow: null,
    },
    task: null,
    measurements: [measurement],
    outcome: null,
    usage: null,
    sourceClass: "external",
    evidence: [
      valueEvidence(row.id, "openrouter-model-field", measurement, fetchedAt),
      mappingEvidence(row.id, mapping, fetchedAt),
    ],
    freshness: { observedAt: fetchedAt, validUntil: earlier(mapping.validUntil, validUntil) },
    uncertainty: {
      level: "moderate",
      basis: [
        "facts are declared by the official OpenRouter models API",
        "model identity is supplied by an exact content-addressed row mapping",
      ],
      gaps: [
        "facts describe OpenRouter routing and may differ from direct-provider availability or limits",
        "mapping review acceptance is enforced by the calling refresh policy rather than this deterministic adapter",
        "Bearing validates snapshot binding but relies on Forage/Lookout to authenticate source acquisition",
      ],
    },
  });

const benchmarkSemantics = {
  intelligence: { family: "reasoning", key: "artificial-analysis.intelligence_index" },
  coding: { family: "software-engineering", key: "artificial-analysis.coding_index" },
  agentic: { family: "software-engineering", key: "artificial-analysis.agentic_index" },
} as const;

const benchmarkObservations = (
  row: ParsedOpenRouterModelRow,
  mapping: OpenRouterModelMapping,
  fetchedAt: string,
  validUntil: string,
): ObservationInput[] => {
  if (row.artificialAnalysis === null) return [];
  return (Object.keys(benchmarkSemantics) as Array<keyof typeof benchmarkSemantics>)
    .filter((key) => row.artificialAnalysis?.[key] !== null)
    .map((key) => {
      const semantics = benchmarkSemantics[key];
      const value = row.artificialAnalysis![key]!;
      const sample = { benchmark: "artificial-analysis", key, value };
      return validateObservation({
        schemaVersion: OBSERVATION_SCHEMA_VERSION,
        kind: "declaration",
        model: mapping.model,
        execution: null,
        task: {
          family: semantics.family,
          suite: "artificial-analysis",
          taskId: key,
          evaluator: { id: "artificial-analysis", version: null },
        },
        measurements: [{ key: semantics.key, kind: "sample", value, unit: "index" }],
        outcome: null,
        usage: null,
        sourceClass: "external",
        evidence: [
          valueEvidence(row.id, "openrouter-attributed-artificial-analysis", sample, fetchedAt),
          attributionEvidence("artificial-analysis", OPENROUTER_MODELS_SOURCE.artificialAnalysisUrl, fetchedAt),
          mappingEvidence(row.id, mapping, fetchedAt),
        ],
        freshness: { observedAt: fetchedAt, validUntil: earlier(mapping.validUntil, validUntil) },
        uncertainty: {
          level: "high",
          basis: ["OpenRouter explicitly attributes this index value to Artificial Analysis"],
          gaps: [
            "the OpenRouter snapshot does not establish the exact upstream benchmark revision or methodology",
            "the attributed index is an external prior and does not prove performance in the caller's workflow",
            "mapping review acceptance is enforced by the calling refresh policy rather than this deterministic adapter",
          ],
        },
      });
    });
};

const designArenaObservations = (
  row: ParsedOpenRouterModelRow,
  mapping: OpenRouterModelMapping,
  fetchedAt: string,
  validUntil: string,
): ObservationInput[] => row.designArena.map((sample) => {
  return validateObservation({
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    kind: "declaration",
    model: mapping.model,
    execution: null,
    task: {
      family: "design",
      suite: "design-arena",
      taskId: `${sample.arena}/${sample.category}`,
      evaluator: { id: "design-arena", version: null },
    },
    measurements: [
      { key: "design-arena.elo", kind: "sample", value: sample.elo, unit: "Elo" },
      { key: "design-arena.win_rate", kind: "sample", value: sample.winRate, unit: "percent" },
      { key: "design-arena.rank", kind: "sample", value: sample.rank, unit: "rank" },
    ],
    outcome: null,
    usage: null,
    sourceClass: "external",
    evidence: [
      valueEvidence(row.id, "openrouter-attributed-design-arena", sample, fetchedAt),
      attributionEvidence("design-arena", OPENROUTER_MODELS_SOURCE.designArenaUrl, fetchedAt),
      mappingEvidence(row.id, mapping, fetchedAt),
    ],
    freshness: { observedAt: fetchedAt, validUntil: earlier(mapping.validUntil, validUntil) },
    uncertainty: {
      level: "high",
      basis: ["OpenRouter explicitly attributes this arena/category result to Design Arena"],
      gaps: [
        "the OpenRouter snapshot does not establish the exact upstream leaderboard revision or methodology",
        "the attributed result is an external prior and does not prove performance in the caller's workflow",
        "mapping review acceptance is enforced by the calling refresh policy rather than this deterministic adapter",
      ],
    },
  });
});

const mappedRowObservations = (
  row: ParsedOpenRouterModelRow,
  mapping: OpenRouterModelMapping,
  fetchedAt: string,
  validUntil: string,
): ObservationInput[] => [
  ...factMeasurements(row).map((measurement) => factObservation(row, mapping, measurement, fetchedAt, validUntil)),
  ...benchmarkObservations(row, mapping, fetchedAt, validUntil),
  ...designArenaObservations(row, mapping, fetchedAt, validUntil),
];

const mappedRowObservationCount = (row: ParsedOpenRouterModelRow): number => {
  const benchmarkCount = row.artificialAnalysis === null
    ? 0
    : Object.values(row.artificialAnalysis).filter((value) => value !== null).length;
  return factMeasurements(row).length + benchmarkCount + row.designArena.length;
};

const estimatedMappedRowBytes = (row: ParsedOpenRouterModelRow, mapping: OpenRouterModelMapping): number => {
  const common = ESTIMATED_FIXED_OBSERVATION_BYTES +
    Buffer.byteLength(JSON.stringify(mapping.model), "utf8") +
    2 * Buffer.byteLength(encodeURIComponent(row.id), "utf8");
  const nonDesignCount = mappedRowObservationCount(row) - row.designArena.length;
  return common * nonDesignCount + row.designArena.reduce(
    (total, sample) => total + common + 2 * Buffer.byteLength(encodeURIComponent(sample.category), "utf8"),
    0,
  );
};

const assertObservationBound = (
  rows: ParsedOpenRouterModelRow[],
  models: ReadonlyMap<string, OpenRouterModelMapping>,
): void => {
  let count = 0;
  for (const row of rows) {
    if (!models.has(row.id)) continue;
    count += mappedRowObservationCount(row);
    if (count > MAX_OBSERVATIONS) {
      return fail("$.snapshot.body.data", `mapped rows must expand to at most ${MAX_OBSERVATIONS} observations`);
    }
  }
  let bytes = 0;
  for (const row of rows) {
    const mapping = models.get(row.id);
    if (mapping === undefined) continue;
    bytes += estimatedMappedRowBytes(row, mapping);
    if (bytes > MAX_NORMALIZED_OUTPUT_BYTES) {
      return fail("$.snapshot.body.data", `mapped rows must expand to at most ${MAX_NORMALIZED_OUTPUT_BYTES} estimated output bytes`);
    }
  }
};

const importRows = (
  rows: ParsedOpenRouterModelRow[],
  models: ReadonlyMap<string, OpenRouterModelMapping>,
  fetchedAt: string,
  validUntil: string,
): { observations: ObservationInput[]; diagnostics: OpenRouterModelsDiagnostic[] } => {
  const observations: ObservationInput[] = [];
  const diagnostics: OpenRouterModelsDiagnostic[] = [];
  rows.forEach((row, index) => {
    const mapping = models.get(row.id);
    if (mapping === undefined) {
      diagnostics.push({ code: "unmapped-model", path: `$.snapshot.body.data[${index}]`, message: `Skipped unmapped OpenRouter model ${row.id}` });
      return;
    }
    observations.push(...mappedRowObservations(row, mapping, fetchedAt, validUntil));
  });
  const rowIds = new Set(rows.map((row) => row.id));
  [...models.keys()].sort(compareText).forEach((modelId) => {
    if (!rowIds.has(modelId)) diagnostics.push({ code: "configured-model-missing", path: `$.models.${modelId}`, message: `Configured OpenRouter model ${modelId} is absent from the source snapshot` });
  });
  return { observations, diagnostics };
};

export const importOpenRouterModelsSnapshot = (input: OpenRouterModelsImportInput): OpenRouterModelsImportResult => {
  const source = approvedSource(input.manifest, input.sourceId);
  const snapshot = validateSnapshot(input.snapshot, source);
  const sourceValidUntil = new Date(
    new Date(snapshot.fetchedAt).getTime() + source.freshness.maxAgeHours * 60 * 60 * 1_000,
  ).toISOString();
  const models = validateMappings(input.models);
  const rows = parseOpenRouterModelRows(snapshot.body);
  assertObservationBound(rows, models);
  const { observations, diagnostics } = importRows(rows, models, snapshot.fetchedAt, sourceValidUntil);
  observations.sort((left, right) => {
    const model = compareText(left.model.id, right.model.id);
    if (model !== 0) return model;
    return compareText(left.task?.taskId ?? "", right.task?.taskId ?? "") ||
      compareText(left.measurements[0]?.key ?? "", right.measurements[0]?.key ?? "");
  });
  return {
    observations,
    diagnostics,
    acquisition: {
      sourceId: source.id,
      sourceRef: snapshot.sourceRef,
      sourceUrl: source.resolver.entrypoint.url,
      bodySha256: snapshot.bodyHash,
      fetchedAt: snapshot.fetchedAt,
      rowCount: rows.length,
      manifestDigest: input.manifest.digest,
      revision: snapshot.bodyHash,
    },
  };
};
