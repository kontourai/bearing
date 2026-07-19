import {
  buildSnapshotSourceRef,
  parseSnapshotSourceRef,
  type SnapshotSourceRefResolution,
} from "@kontourai/forage/fetch";
import { parse } from "csv-parse/sync";
import { getNodeValue, parseTree, type Node, type ParseError } from "jsonc-parser";
import { compareText, sha256 } from "../canonical.js";
import { BearingError } from "../error.js";
import {
  OBSERVATION_SCHEMA_VERSION,
  type ComponentIdentity,
  type ModelIdentity,
  type ObservationInput,
} from "../types.js";
import { validateObservation } from "../validate.js";

const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_REF_LENGTH = 16 * 1024;
const MAX_ROWS = 10_000;
const MAX_COLUMNS = 512;
const MAX_CSV_CELLS = 100_000;
const MAX_CELL_CHARACTERS = 8_192;
const MAX_OBSERVATIONS = 50_000;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_STRUCTURAL_TOKENS = 20_000;
const RELEASE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const NUMBER_PATTERN = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export const LIVEBENCH_SOURCE = Object.freeze({
  idPrefix: "livebench",
  owner: "LiveBench",
  origin: "https://livebench.ai",
  license: "NOASSERTION",
  sourceClass: "external" as const,
});

export type LiveBenchArtifact = "table" | "categories";

/** Successful exact Forage/Lookout replay result; Bearing revalidates its full envelope. */
export type LiveBenchTrustedSnapshot = Extract<SnapshotSourceRefResolution, { ok: true }>;

export interface LiveBenchRunMapping {
  model: ModelIdentity;
  runtime: ComponentIdentity;
  workflowCondition: string;
  validUntil: string | null;
}

export interface LiveBenchImportInput {
  release: string;
  tableSnapshot: LiveBenchTrustedSnapshot;
  categoriesSnapshot: LiveBenchTrustedSnapshot;
  /** Exact upstream table model id to reviewed model/runtime identity. */
  runs: Readonly<Record<string, LiveBenchRunMapping>>;
}

export interface LiveBenchDiagnostic {
  code: "unmapped-run" | "configured-run-missing";
  path: string;
  message: string;
}

export interface LiveBenchImportResult {
  observations: ObservationInput[];
  diagnostics: LiveBenchDiagnostic[];
  acquisition: {
    release: string;
    table: SourceAcquisition;
    categories: SourceAcquisition;
  };
}

interface SourceAcquisition {
  sourceId: string;
  sourceRef: string;
  sourceUrl: string;
  bodySha256: string;
  fetchedAt: string;
}

interface ParsedRow {
  modelId: string;
  scores: Array<{ task: string; score: number }>;
}

interface LiveBenchTaskSemantics {
  category: string;
  family: string;
  measurementKey: string;
}

const CATEGORY_DEFINITIONS = Object.freeze({
  "Reasoning": { family: "reasoning", measurementKey: "livebench.reasoning.score" },
  "Coding": { family: "software-engineering", measurementKey: "livebench.coding.score" },
  "Agentic Coding": { family: "software-engineering", measurementKey: "livebench.agentic-coding.score" },
  "Mathematics": { family: "mathematics", measurementKey: "livebench.mathematics.score" },
  "Data Analysis": { family: "data-analysis", measurementKey: "livebench.data-analysis.score" },
  "Language": { family: "language", measurementKey: "livebench.language.score" },
  "IF": { family: "instruction-following", measurementKey: "livebench.instruction-following.score" },
} as const);

const fail = (path: string, message: string): never => {
  throw new BearingError("INVALID_SOURCE_SNAPSHOT", path, message);
};

const nonEmptyText = (value: unknown, path: string): string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_CELL_CHARACTERS
    ? value
    : fail(path, `must be a non-empty string of at most ${MAX_CELL_CHARACTERS} characters`);

const isoTimestamp = (value: unknown, path: string): string => {
  if (typeof value !== "string") return fail(path, "must be an ISO-8601 UTC timestamp");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    return fail(path, "must be an ISO-8601 UTC timestamp");
  }
  return value;
};

const releaseTimestamp = (release: string): string => {
  if (!RELEASE_PATTERN.test(release)) return fail("$.release", "must use YYYY-MM-DD");
  const value = `${release}T00:00:00.000Z`;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    return fail("$.release", "must be a real calendar date");
  }
  return value;
};

const decodeBody = (body: string | Uint8Array, path: string): string => {
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (typeof body === "string" && decoded !== body) {
      return fail(path, "must round-trip through the exact UTF-8 bytes committed by the snapshot");
    }
    return decoded;
  } catch {
    return fail(path, "must be valid UTF-8");
  }
};

export const liveBenchSourceId = (release: string, artifact: LiveBenchArtifact): string =>
  `${LIVEBENCH_SOURCE.idPrefix}-${release}-${artifact}`;

export const liveBenchSourceUrl = (release: string, artifact: LiveBenchArtifact): string => {
  releaseTimestamp(release);
  const suffix = release.replaceAll("-", "_");
  return `${LIVEBENCH_SOURCE.origin}/${artifact}_${suffix}.${artifact === "table" ? "csv" : "json"}`;
};

interface ValidatedSnapshot {
  body: string;
  sourceRef: string;
  snapshot: LiveBenchTrustedSnapshot["snapshot"];
}

const validateSnapshot = (
  resolution: LiveBenchTrustedSnapshot,
  release: string,
  artifact: LiveBenchArtifact,
): ValidatedSnapshot => {
  const path = `$.${artifact}Snapshot`;
  if (resolution === null || typeof resolution !== "object" || resolution.ok !== true) {
    return fail(path, "must be a successful exact snapshot resolution");
  }
  if (resolution.integrity !== "snapshot-envelope") {
    return fail(`${path}.integrity`, "must cite a full snapshot envelope");
  }
  let sourceRef: string;
  try {
    sourceRef = buildSnapshotSourceRef(resolution.snapshot);
  } catch {
    return fail(path, "must contain a valid canonical durable snapshot");
  }
  if (sourceRef.length > MAX_SOURCE_REF_LENGTH) {
    return fail(`${path}.reference`, `must encode within ${MAX_SOURCE_REF_LENGTH} characters`);
  }
  const canonicalReference = parseSnapshotSourceRef(sourceRef)!;
  if (
    resolution.reference.sourceId !== canonicalReference.sourceId ||
    resolution.reference.url !== canonicalReference.url ||
    resolution.reference.bodyHash !== canonicalReference.bodyHash ||
    resolution.reference.fetchedAt !== canonicalReference.fetchedAt ||
    resolution.reference.snapshotDigest !== canonicalReference.snapshotDigest
  ) {
    return fail(`${path}.reference`, "must exactly match the recomputed snapshot envelope");
  }
  const expectedSourceId = liveBenchSourceId(release, artifact);
  const expectedUrl = liveBenchSourceUrl(release, artifact);
  if (
    resolution.snapshot.sourceId !== expectedSourceId ||
    resolution.snapshot.url !== expectedUrl ||
    resolution.snapshot.status !== 200
  ) {
    return fail(path, "must bind the official release artifact identity and a successful response");
  }
  const bytes = typeof resolution.snapshot.body === "string"
    ? Buffer.from(resolution.snapshot.body, "utf8")
    : resolution.snapshot.body;
  if (bytes.byteLength > MAX_SOURCE_BYTES) {
    return fail(`${path}.body`, `exceeds ${MAX_SOURCE_BYTES} bytes`);
  }
  isoTimestamp(resolution.snapshot.fetchedAt, `${path}.snapshot.fetchedAt`);
  return {
    body: decodeBody(resolution.snapshot.body, `${path}.snapshot.body`),
    sourceRef,
    snapshot: resolution.snapshot,
  };
};

const preflightJsonBounds = (body: string): void => {
  let depth = 0;
  let structuralTokens = 0;
  let inString = false;
  let escaped = false;
  for (const character of body) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      depth += 1;
      structuralTokens += 1;
      if (depth > MAX_JSON_DEPTH) {
        return fail("$.categoriesSnapshot.body", `exceeds the maximum JSON depth of ${MAX_JSON_DEPTH}`);
      }
    } else if (character === "}" || character === "]") {
      depth -= 1;
      structuralTokens += 1;
    } else if (character === "," || character === ":") {
      structuralTokens += 1;
    }
    if (structuralTokens > MAX_JSON_STRUCTURAL_TOKENS) {
      return fail("$.categoriesSnapshot.body", "exceeds the bounded JSON structure size");
    }
  }
};

const assertUniqueObjectKeys = (root: Node, rootPath: string): void => {
  const pending: Array<{ node: Node; path: string }> = [{ node: root, path: rootPath }];
  while (pending.length > 0) {
    const { node, path } = pending.pop()!;
    if (node.type === "object") {
      const seen = new Set<string>();
      for (const property of node.children ?? []) {
        const keyNode = property.children?.[0];
        const valueNode = property.children?.[1];
        if (keyNode === undefined || typeof keyNode.value !== "string" || valueNode === undefined) {
          return fail(path, "must contain complete JSON properties");
        }
        if (seen.has(keyNode.value)) return fail(`${path}.${keyNode.value}`, "must not duplicate an object key");
        seen.add(keyNode.value);
        pending.push({ node: valueNode, path: `${path}.${keyNode.value}` });
      }
    } else if (node.type === "array") {
      (node.children ?? []).forEach((child, index) => pending.push({ node: child, path: `${path}[${index}]` }));
    }
  }
};

const parseCategories = (body: string): Map<string, LiveBenchTaskSemantics> => {
  preflightJsonBounds(body);
  const errors: ParseError[] = [];
  let tree: Node | undefined;
  try {
    tree = parseTree(body, errors, { allowTrailingComma: false, disallowComments: true });
  } catch {
    return fail("$.categoriesSnapshot.body", "exceeds the bounded JSON parser capacity");
  }
  if (tree === undefined || errors.length > 0) {
    return fail("$.categoriesSnapshot.body", "must be strict valid JSON");
  }
  assertUniqueObjectKeys(tree, "$.categoriesSnapshot.body");
  const value = getNodeValue(tree) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("$.categoriesSnapshot.body", "must contain a category object");
  }
  const source = value as Record<string, unknown>;
  const expectedCategories = Object.keys(CATEGORY_DEFINITIONS).sort(compareText);
  const actualCategories = Object.keys(source).sort(compareText);
  if (JSON.stringify(actualCategories) !== JSON.stringify(expectedCategories)) {
    return fail("$.categoriesSnapshot.body", "must contain exactly the reviewed category set");
  }

  const taskSemantics = new Map<string, LiveBenchTaskSemantics>();
  for (const category of expectedCategories) {
    const tasks = source[category];
    if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > MAX_COLUMNS - 1) {
      return fail(`$.categoriesSnapshot.body.${category}`, "must be a non-empty bounded task array");
    }
    for (let index = 0; index < tasks.length; index += 1) {
      const task = nonEmptyText(tasks[index], `$.categoriesSnapshot.body.${category}[${index}]`);
      if (task === "model") return fail(`$.categoriesSnapshot.body.${category}[${index}]`, "uses reserved task name model");
      if (taskSemantics.has(task)) {
        return fail(`$.categoriesSnapshot.body.${category}[${index}]`, `duplicates task ${task}`);
      }
      const definition = CATEGORY_DEFINITIONS[category as keyof typeof CATEGORY_DEFINITIONS];
      taskSemantics.set(task, { category, ...definition });
    }
  }
  return taskSemantics;
};

const parseScore = (value: unknown, path: string): number => {
  if (typeof value !== "string" || !NUMBER_PATTERN.test(value)) {
    return fail(path, "must be a finite decimal score");
  }
  const score = Number(value);
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    return fail(path, "must be between 0 and 100");
  }
  return score;
};

const preflightCsvBounds = (body: string): void => {
  const maxRawFieldCharacters = MAX_CELL_CHARACTERS * 2 + 2;
  let inQuotes = false;
  let columns = 1;
  let records = 0;
  let cells = 0;
  let rawFieldCharacters = 0;
  let endedWithRecordSeparator = false;

  const completeField = (): void => {
    if (rawFieldCharacters > maxRawFieldCharacters) {
      return fail("$.tableSnapshot.body", "contains a field that exceeds the bounded cell size");
    }
    rawFieldCharacters = 0;
  };
  const completeRecord = (): void => {
    completeField();
    records += 1;
    if (records > MAX_ROWS + 1) {
      return fail("$.tableSnapshot.body", `contains more than ${MAX_ROWS} rows`);
    }
    cells += columns;
    if (cells > MAX_CSV_CELLS) {
      return fail("$.tableSnapshot.body", `contains more than ${MAX_CSV_CELLS} bounded CSV cells`);
    }
    columns = 1;
  };

  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    endedWithRecordSeparator = false;
    if (character === '"') {
      rawFieldCharacters += 1;
      if (inQuotes && body[index + 1] === '"') {
        rawFieldCharacters += 1;
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (!inQuotes && character === ",") {
      completeField();
      columns += 1;
      if (columns > MAX_COLUMNS) {
        return fail("$.tableSnapshot.body", `contains more than ${MAX_COLUMNS} columns`);
      }
    } else if (!inQuotes && (character === "\n" || character === "\r")) {
      completeRecord();
      endedWithRecordSeparator = true;
      if (character === "\r" && body[index + 1] === "\n") index += 1;
    } else {
      rawFieldCharacters += 1;
      if (rawFieldCharacters > maxRawFieldCharacters) {
        return fail("$.tableSnapshot.body", "contains a field that exceeds the bounded cell size");
      }
    }
  }
  if (body.length > 0 && !endedWithRecordSeparator) completeRecord();
};

const parseTable = (body: string, taskSemantics: ReadonlyMap<string, LiveBenchTaskSemantics>): ParsedRow[] => {
  preflightCsvBounds(body);
  let records: string[][];
  try {
    records = parse(body, {
      bom: true,
      cast: false,
      relax_column_count: false,
      skip_empty_lines: false,
      max_record_size: MAX_CELL_CHARACTERS * MAX_COLUMNS,
    }) as string[][];
  } catch {
    return fail("$.tableSnapshot.body", "must be valid bounded CSV with equal row widths");
  }
  if (records.length < 2) return fail("$.tableSnapshot.body", "must contain a header and at least one row");
  if (records.length - 1 > MAX_ROWS) {
    return fail("$.tableSnapshot.body", `contains more than ${MAX_ROWS} rows`);
  }
  const header = records[0];
  if (header.length < 2 || header.length > MAX_COLUMNS || header[0] !== "model") {
    return fail("$.tableSnapshot.body[0]", `must start with model and contain at most ${MAX_COLUMNS} columns`);
  }
  const tasks = header.slice(1).map((task, index) =>
    nonEmptyText(task, `$.tableSnapshot.body[0][${index + 1}]`));
  const uniqueTasks = new Set(tasks);
  if (uniqueTasks.size !== tasks.length) return fail("$.tableSnapshot.body[0]", "contains duplicate task columns");
  const categoryTasks = [...taskSemantics.keys()].sort(compareText);
  const tableTasks = [...tasks].sort(compareText);
  if (JSON.stringify(categoryTasks) !== JSON.stringify(tableTasks)) {
    return fail("$.tableSnapshot.body[0]", "task columns must exactly match the category manifest");
  }

  const modelIds = new Set<string>();
  return records.slice(1).map((record, rowIndex) => {
    const path = `$.tableSnapshot.body[${rowIndex + 1}]`;
    if (record.length !== header.length) return fail(path, "must match the header width");
    const modelId = nonEmptyText(record[0], `${path}[0]`);
    if (modelIds.has(modelId)) return fail(`${path}[0]`, `duplicates model ${modelId}`);
    modelIds.add(modelId);
    return {
      modelId,
      scores: tasks.map((task, index) => ({
        task,
        score: parseScore(record[index + 1], `${path}[${index + 1}]`),
      })),
    };
  });
};

const validateMapping = (value: unknown, modelId: string): LiveBenchRunMapping => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(`$.runs.${modelId}`, "must be a reviewed model/runtime mapping");
  }
  const mapping = value as LiveBenchRunMapping;
  nonEmptyText(mapping.workflowCondition, `$.runs.${modelId}.workflowCondition`);
  return mapping;
};

const observationFor = (
  row: ParsedRow,
  task: string,
  score: number,
  semantics: LiveBenchTaskSemantics,
  mapping: LiveBenchRunMapping,
  release: string,
): ObservationInput => {
  const observedAt = releaseTimestamp(release);
  const taskResultDigest = sha256({
    release,
    model: row.modelId,
    task,
    score,
  });
  const categoryAssignmentDigest = sha256({
    release,
    task,
    category: semantics.category,
  });
  const mappingDigest = sha256({
    release,
    row: row.modelId,
    mapping,
  });
  return validateObservation({
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    kind: "evaluation",
    model: mapping.model,
    execution: {
      kind: "exact",
      runtime: mapping.runtime,
      adapter: { id: "livebench", version: release },
      effectiveContextTokens: null,
      toolSurface: [],
      hardware: null,
      workflow: {
        id: "livebench",
        version: release,
        condition: mapping.workflowCondition,
      },
    },
    task: {
      family: semantics.family,
      suite: "livebench",
      taskId: task,
      evaluator: { id: "livebench", version: release },
    },
    measurements: [{ key: semantics.measurementKey, kind: "sample", value: score, unit: "percent" }],
    outcome: { status: "accepted", reason: null },
    usage: null,
    sourceClass: "external",
    evidence: [
      {
        id: `livebench-task-result:${taskResultDigest}`,
        kind: "structured-cell",
        uri: `urn:livebench:${release}:${encodeURIComponent(row.modelId)}:${encodeURIComponent(task)}:sha256:${taskResultDigest}`,
        digest: { algorithm: "sha256", value: taskResultDigest },
        observedAt,
      },
      {
        id: `livebench-category-assignment:${categoryAssignmentDigest}`,
        kind: "structured-membership",
        uri: `urn:livebench:${release}:category:${encodeURIComponent(semantics.category)}:${encodeURIComponent(task)}:sha256:${categoryAssignmentDigest}`,
        digest: { algorithm: "sha256", value: categoryAssignmentDigest },
        observedAt,
      },
      {
        id: `livebench-mapping-entry:${mappingDigest}`,
        kind: "model-mapping",
        uri: `urn:bearing:livebench-mapping:${release}:${encodeURIComponent(row.modelId)}:sha256:${mappingDigest}`,
        digest: { algorithm: "sha256", value: mappingDigest },
        observedAt,
      },
    ],
    freshness: { observedAt, validUntil: mapping.validUntil },
    uncertainty: {
      level: "moderate",
      basis: [
        "exact task result and category assignment are independently content-addressed",
        "model, runtime, and workflow condition are supplied by an exact content-addressed row mapping",
      ],
      gaps: [
        "release-wide snapshot acquisition references must accompany catalog publication for origin audit",
        "mapping review acceptance is enforced by the calling refresh policy rather than this deterministic adapter",
        "benchmark source does not disclose effective context size, tool surface, or hardware in the release table",
        "benchmark result does not establish behavior outside its exact LiveBench task and execution condition",
        "Bearing validates snapshot binding but relies on Forage/Lookout to authenticate source acquisition",
      ],
    },
  });
};

export const importLiveBenchSnapshots = (input: LiveBenchImportInput): LiveBenchImportResult => {
  releaseTimestamp(input.release);
  const table = validateSnapshot(input.tableSnapshot, input.release, "table");
  const categories = validateSnapshot(input.categoriesSnapshot, input.release, "categories");
  if (input.runs === null || typeof input.runs !== "object" || Array.isArray(input.runs)) {
    return fail("$.runs", "must be an exact model-row mapping");
  }
  const taskSemantics = parseCategories(categories.body);
  const rows = parseTable(table.body, taskSemantics);
  const rowIds = new Set(rows.map((row) => row.modelId));
  const mappedRowCount = rows.filter((row) => Object.prototype.hasOwnProperty.call(input.runs, row.modelId)).length;
  if (mappedRowCount * taskSemantics.size > MAX_OBSERVATIONS) {
    return fail("$.runs", `would expand beyond ${MAX_OBSERVATIONS} task observations`);
  }
  const observations: ObservationInput[] = [];
  const diagnostics: LiveBenchDiagnostic[] = [];

  rows.forEach((row, rowIndex) => {
    if (!Object.prototype.hasOwnProperty.call(input.runs, row.modelId)) {
      diagnostics.push({
        code: "unmapped-run",
        path: `$.tableSnapshot.body[${rowIndex + 1}]`,
        message: `Skipped unmapped LiveBench run ${row.modelId}`,
      });
      return;
    }
    const mapping = validateMapping(input.runs[row.modelId], row.modelId);
    row.scores.forEach(({ task, score }) => {
      observations.push(observationFor(
        row,
        task,
        score,
        taskSemantics.get(task)!,
        mapping,
        input.release,
      ));
    });
  });

  Object.keys(input.runs).sort(compareText).forEach((modelId) => {
    if (!rowIds.has(modelId)) {
      diagnostics.push({
        code: "configured-run-missing",
        path: `$.runs.${modelId}`,
        message: `Configured LiveBench run ${modelId} is absent from the source snapshot`,
      });
    }
  });
  observations.sort((left, right) => {
    const model = compareText(left.model.id, right.model.id);
    return model !== 0 ? model : compareText(left.task?.taskId ?? "", right.task?.taskId ?? "");
  });
  return {
    observations,
    diagnostics,
    acquisition: {
      release: input.release,
      table: {
        sourceId: table.snapshot.sourceId,
        sourceRef: table.sourceRef,
        sourceUrl: liveBenchSourceUrl(input.release, "table"),
        bodySha256: table.snapshot.bodyHash,
        fetchedAt: table.snapshot.fetchedAt,
      },
      categories: {
        sourceId: categories.snapshot.sourceId,
        sourceRef: categories.sourceRef,
        sourceUrl: liveBenchSourceUrl(input.release, "categories"),
        bodySha256: categories.snapshot.bodyHash,
        fetchedAt: categories.snapshot.fetchedAt,
      },
    },
  };
};
