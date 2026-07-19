import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
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
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;

export const AIDER_POLYGLOT_SOURCE = Object.freeze({
  id: "aider-polyglot-leaderboard",
  owner: "Aider-AI",
  repository: "aider",
  path: "aider/website/_data/polyglot_leaderboard.yml",
  license: "Apache-2.0",
  sourceClass: "external" as const,
});

export interface TrustedSourceSnapshot {
  /** Must be produced from a successful exact Forage/Lookout replay upstream. */
  body: string | Uint8Array;
  bodySha256: string;
  sourceRef: string;
  integrity: "snapshot-envelope";
  fetchedAt: string;
  sourceCommit: string;
}

export interface AiderPolyglotRunMapping {
  model: ModelIdentity;
  runtime: ComponentIdentity;
  validUntil: string | null;
}

export interface AiderPolyglotImportInput {
  snapshot: TrustedSourceSnapshot;
  /** Exact upstream `dirname` to reviewed model/runtime identity. */
  runs: Readonly<Record<string, AiderPolyglotRunMapping>>;
}

export interface AiderPolyglotDiagnostic {
  code: "unmapped-run" | "configured-run-missing";
  path: string;
  message: string;
}

export interface AiderPolyglotImportResult {
  observations: ObservationInput[];
  diagnostics: AiderPolyglotDiagnostic[];
  acquisition: {
    sourceRef: string;
    sourceUrl: string;
    bodySha256: string;
    fetchedAt: string;
    sourceCommit: string;
  };
}

interface AiderRow {
  dirname: string;
  model: string;
  editFormat: string;
  benchmarkCommit: string;
  date: string;
  aiderVersion: string;
  testCases: number;
  totalTests: number;
  passRate1: number;
  passRate2: number;
  wellFormedPercent: number;
  secondsPerCase: number;
  totalCost: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
}

const fail = (path: string, message: string): never => {
  throw new BearingError("INVALID_SOURCE_SNAPSHOT", path, message);
};

const record = (value: unknown, path: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(path, "must be an object");
  }
  return value as Record<string, unknown>;
};

const text = (value: unknown, path: string): string =>
  typeof value === "string" && value.length > 0 ? value : fail(path, "must be a non-empty string");

const finite = (value: unknown, path: string): number => {
  const result = typeof value === "number"
    ? value
    : typeof value === "string" && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(result) ? result : fail(path, "must be a finite number");
};

const nonNegative = (value: unknown, path: string): number => {
  const result = finite(value, path);
  return result >= 0 ? result : fail(path, "must be non-negative");
};

const percent = (value: unknown, path: string): number => {
  const result = finite(value, path);
  return result >= 0 && result <= 100 ? result : fail(path, "must be between 0 and 100");
};

const integer = (value: unknown, path: string): number => {
  const result = finite(value, path);
  return Number.isSafeInteger(result) && result >= 0
    ? result
    : fail(path, "must be a non-negative safe integer");
};

const positiveInteger = (value: unknown, path: string): number => {
  const result = integer(value, path);
  return result > 0 ? result : fail(path, "must be a positive integer");
};

const optionalInteger = (value: unknown, path: string): number | null =>
  value === undefined ? null : integer(value, path);

const optionalNonNegative = (value: unknown, path: string): number | null =>
  value === undefined ? null : nonNegative(value, path);

const isoTimestamp = (value: string, path: string): string => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    return fail(path, "must be an ISO-8601 UTC timestamp");
  }
  return value;
};

const runTimestamp = (value: unknown, path: string): string => {
  const date = text(value, path);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(path, "must use YYYY-MM-DD");
  return isoTimestamp(`${date}T00:00:00.000Z`, path);
};

const decodeBody = (body: string | Uint8Array): string => {
  if (typeof body === "string") return body;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return fail("$.snapshot.body", "must be valid UTF-8");
  }
};

export const aiderPolyglotSourceUrl = (commit: string): string =>
  `https://raw.githubusercontent.com/${AIDER_POLYGLOT_SOURCE.owner}/${AIDER_POLYGLOT_SOURCE.repository}/${commit}/${AIDER_POLYGLOT_SOURCE.path}`;

const validateSourceRef = (snapshot: TrustedSourceSnapshot): string => {
  if (snapshot.integrity !== "snapshot-envelope") {
    return fail("$.snapshot.integrity", "must cite a verified snapshot envelope");
  }
  if (
    typeof snapshot.sourceRef !== "string" ||
    snapshot.sourceRef.length === 0 ||
    snapshot.sourceRef.length > MAX_SOURCE_REF_LENGTH
  ) {
    return fail("$.snapshot.sourceRef", `must be between 1 and ${MAX_SOURCE_REF_LENGTH} characters`);
  }
  const marker = "&snapshotSha256=";
  const markerIndex = snapshot.sourceRef.lastIndexOf(marker);
  if (markerIndex < 0) return fail("$.snapshot.sourceRef", "must cite a full snapshot envelope");
  const snapshotDigest = snapshot.sourceRef.slice(markerIndex + marker.length);
  if (!SHA256_PATTERN.test(snapshotDigest)) {
    return fail("$.snapshot.sourceRef", "must contain a lowercase snapshot envelope digest");
  }
  const sourceUrl = aiderPolyglotSourceUrl(snapshot.sourceCommit);
  const params = new URLSearchParams({
    url: sourceUrl,
    sha256: snapshot.bodySha256,
    fetchedAt: snapshot.fetchedAt,
    snapshotSha256: snapshotDigest,
  });
  const expected = `forage-snapshot:${encodeURIComponent(AIDER_POLYGLOT_SOURCE.id)}?${params}`;
  if (snapshot.sourceRef !== expected) {
    return fail("$.snapshot.sourceRef", "must canonically bind the official immutable source URL and snapshot bytes");
  }
  return sourceUrl;
};

const validateSnapshot = (snapshot: TrustedSourceSnapshot): string => {
  if (snapshot === null || typeof snapshot !== "object") return fail("$.snapshot", "must be an object");
  if (typeof snapshot.body !== "string" && !(snapshot.body instanceof Uint8Array)) {
    return fail("$.snapshot.body", "must be a string or Uint8Array");
  }
  const bytes = typeof snapshot.body === "string"
    ? Buffer.from(snapshot.body, "utf8")
    : snapshot.body;
  if (bytes.byteLength > MAX_SOURCE_BYTES) {
    return fail("$.snapshot.body", `exceeds ${MAX_SOURCE_BYTES} bytes`);
  }
  if (!SHA256_PATTERN.test(snapshot.bodySha256)) {
    return fail("$.snapshot.bodySha256", "must be a lowercase SHA-256 digest");
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== snapshot.bodySha256) return fail("$.snapshot.bodySha256", "does not match snapshot bytes");
  isoTimestamp(snapshot.fetchedAt, "$.snapshot.fetchedAt");
  if (!COMMIT_PATTERN.test(snapshot.sourceCommit)) {
    return fail("$.snapshot.sourceCommit", "must be a full lowercase Git commit SHA");
  }
  validateSourceRef(snapshot);
  return decodeBody(snapshot.body);
};

const parseRows = (body: string): unknown[] => {
  const document = parseDocument(body, {
    prettyErrors: false,
    schema: "failsafe",
    uniqueKeys: true,
  });
  if (document.errors.length > 0) return fail("$.snapshot.body", "is not valid bounded YAML");
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch {
    return fail("$.snapshot.body", "uses unsupported YAML aliases");
  }
  if (!Array.isArray(value)) return fail("$", "must contain a leaderboard row array");
  if (value.length > MAX_ROWS) return fail("$", `contains more than ${MAX_ROWS} rows`);
  return value;
};

const parseMappedRow = (value: unknown, index: number): AiderRow => {
  const path = `$[${index}]`;
  const item = record(value, path);
  const row: AiderRow = {
    dirname: text(item.dirname, `${path}.dirname`),
    model: text(item.model, `${path}.model`),
    editFormat: text(item.edit_format, `${path}.edit_format`),
    benchmarkCommit: text(item.commit_hash, `${path}.commit_hash`),
    date: runTimestamp(item.date, `${path}.date`),
    aiderVersion: text(item.versions, `${path}.versions`),
    testCases: positiveInteger(item.test_cases, `${path}.test_cases`),
    totalTests: positiveInteger(item.total_tests, `${path}.total_tests`),
    passRate1: percent(item.pass_rate_1, `${path}.pass_rate_1`),
    passRate2: percent(item.pass_rate_2, `${path}.pass_rate_2`),
    wellFormedPercent: percent(item.percent_cases_well_formed, `${path}.percent_cases_well_formed`),
    secondsPerCase: nonNegative(item.seconds_per_case, `${path}.seconds_per_case`),
    totalCost: optionalNonNegative(item.total_cost, `${path}.total_cost`),
    promptTokens: optionalInteger(item.prompt_tokens, `${path}.prompt_tokens`),
    completionTokens: optionalInteger(item.completion_tokens, `${path}.completion_tokens`),
  };
  if (row.testCases > row.totalTests) {
    return fail(`${path}.test_cases`, "must not exceed total_tests");
  }
  return row;
};

const rowName = (value: unknown, index: number): string =>
  text(record(value, `$[${index}]`).dirname, `$[${index}].dirname`);

const observationFor = (
  row: AiderRow,
  rawRow: unknown,
  mapping: AiderPolyglotRunMapping,
  snapshot: TrustedSourceSnapshot,
): ObservationInput => {
  const totalTokens = row.promptTokens === null || row.completionTokens === null
    ? null
    : row.promptTokens + row.completionTokens;
  const gaps = [
    "benchmark source does not disclose effective context size or hardware",
    "benchmark result does not establish behavior outside the Aider Polyglot suite",
    "Bearing validates snapshot binding but relies on Forage/Lookout to authenticate source acquisition",
  ];
  if (totalTokens === null) gaps.push("benchmark row does not report complete token usage");
  if (row.totalCost === null) gaps.push("benchmark row does not report total cost");
  const measurements: ObservationInput["measurements"] = [
    { key: "aider.polyglot.pass_rate_1", kind: "sample", value: row.passRate1, unit: "percent" },
    { key: "aider.polyglot.pass_rate_2", kind: "sample", value: row.passRate2, unit: "percent" },
    { key: "aider.polyglot.well_formed", kind: "sample", value: row.wellFormedPercent, unit: "percent" },
    { key: "aider.polyglot.test_cases", kind: "sample", value: row.testCases, unit: "cases" },
    { key: "aider.polyglot.total_tests", kind: "sample", value: row.totalTests, unit: "tests" },
    { key: "aider.polyglot.seconds_per_case", kind: "sample", value: row.secondsPerCase, unit: "seconds" },
  ];
  if (row.totalCost !== null) {
    measurements.push({ key: "aider.polyglot.total_cost", kind: "sample", value: row.totalCost, unit: "USD" });
  }
  const rowDigest = sha256(rawRow);
  const input: ObservationInput = {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    kind: "evaluation",
    model: mapping.model,
    execution: {
      kind: "exact",
      runtime: mapping.runtime,
      adapter: { id: "aider", version: row.aiderVersion },
      effectiveContextTokens: null,
      toolSurface: [],
      hardware: null,
      workflow: {
        id: "aider.polyglot",
        version: row.benchmarkCommit,
        condition: `edit_format=${row.editFormat}`,
      },
    },
    task: {
      family: "software-engineering",
      suite: "aider.polyglot",
      taskId: null,
      evaluator: { id: "aider.polyglot", version: row.benchmarkCommit },
    },
    measurements,
    outcome: { status: "accepted", reason: null },
    usage: {
      inputTokens: row.promptTokens,
      outputTokens: row.completionTokens,
      reasoningTokens: null,
      totalTokens,
      completeness: totalTokens === null ? "partial" : "complete",
      modelCalls: null,
      wallTimeMs: Math.round(row.secondsPerCase * row.testCases * 1000),
    },
    sourceClass: "external",
    evidence: [
      {
        id: `aider-polyglot-source:${snapshot.bodySha256}`,
        kind: "forage-snapshot",
        uri: `urn:forage:snapshot:sha256:${snapshot.bodySha256}`,
        digest: { algorithm: "sha256", value: snapshot.bodySha256 },
        observedAt: row.date,
      },
      {
        id: `aider-polyglot-run:${row.dirname}:${rowDigest}`,
        kind: "structured-row",
        uri: `urn:aider:polyglot:${encodeURIComponent(row.dirname)}:sha256:${rowDigest}`,
        digest: { algorithm: "sha256", value: rowDigest },
        observedAt: row.date,
      },
    ],
    freshness: { observedAt: row.date, validUntil: mapping.validUntil },
    uncertainty: {
      level: "moderate",
      basis: [
        "structured result internally bound to the official immutable Aider leaderboard URL by a full snapshot envelope",
        "model and runtime identity supplied by an exact reviewed run mapping",
      ],
      gaps,
    },
  };
  return validateObservation(input);
};

export const importAiderPolyglotSnapshot = (
  input: AiderPolyglotImportInput,
): AiderPolyglotImportResult => {
  const body = validateSnapshot(input.snapshot);
  if (input.runs === null || typeof input.runs !== "object" || Array.isArray(input.runs)) {
    return fail("$.runs", "must be an exact dirname mapping");
  }
  const rows = parseRows(body);
  const names = new Map<string, number>();
  rows.forEach((row, index) => {
    const name = rowName(row, index);
    if (names.has(name)) return fail(`$[${index}].dirname`, `duplicates row ${name}`);
    names.set(name, index);
  });

  const observations: ObservationInput[] = [];
  const diagnostics: AiderPolyglotDiagnostic[] = [];
  rows.forEach((rawRow, index) => {
    const dirname = rowName(rawRow, index);
    if (!Object.prototype.hasOwnProperty.call(input.runs, dirname)) {
      diagnostics.push({
        code: "unmapped-run",
        path: `$[${index}]`,
        message: `Skipped unmapped Aider run ${dirname}`,
      });
      return;
    }
    const mapping = input.runs[dirname];
    if (mapping === null || typeof mapping !== "object" || Array.isArray(mapping)) {
      return fail(`$.runs.${dirname}`, "must be a reviewed model/runtime mapping");
    }
    observations.push(observationFor(parseMappedRow(rawRow, index), rawRow, mapping, input.snapshot));
  });
  Object.keys(input.runs).sort(compareText).forEach((dirname) => {
    if (!names.has(dirname)) {
      diagnostics.push({
        code: "configured-run-missing",
        path: `$.runs.${dirname}`,
        message: `Configured Aider run ${dirname} is absent from the source snapshot`,
      });
    }
  });
  observations.sort((left, right) => compareText(left.evidence[1].id, right.evidence[1].id));
  return {
    observations,
    diagnostics,
    acquisition: {
      sourceRef: input.snapshot.sourceRef,
      sourceUrl: aiderPolyglotSourceUrl(input.snapshot.sourceCommit),
      bodySha256: input.snapshot.bodySha256,
      fetchedAt: input.snapshot.fetchedAt,
      sourceCommit: input.snapshot.sourceCommit,
    },
  };
};
