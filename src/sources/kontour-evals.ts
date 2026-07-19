import { createHash } from "node:crypto";
import { createScanner, parseTree, SyntaxKind, type Node as JsonNode, type ParseError } from "jsonc-parser";
import { compareText, sha256 } from "../canonical.js";
import { BearingError } from "../error.js";
import {
  OBSERVATION_SCHEMA_VERSION,
  type ComponentIdentity,
  type HardwareProfile,
  type ModelIdentity,
  type ObservationInput,
} from "../types.js";
import { validateObservation } from "../validate.js";

const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_REF_LENGTH = 16 * 1024;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const MAX_RECORDS = 10_000;
const MAX_PHYSICAL_LINES = 20_000;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const MAX_TEXT_LENGTH = 4_096;
const MAX_NORMALIZED_REFERENCE_BYTES = 16 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RESULT_SET_URN_PREFIX = "urn:kontour:evals:result-set:";
const SUPPORTED_USAGE_SOURCES = new Set([
  "codex-rollout-token-count",
  "dry-run",
  "exec-json-turn-completed",
  "exec-json-turn-completed-partial",
  "unavailable",
]);
const COMPLETE_USAGE_SOURCES = new Set(["exec-json-turn-completed"]);
const CONTINUATION_POLICIES = new Set(["single-turn", "matched-compute", "builder-resume", "builder-fresh-context"]);
const AGENT_TOPOLOGIES = new Set(["single-agent", "multi-agent-capable"]);
const REQUIRED_KIT_ROLES = [
  "tool-planner",
  "tool-worker",
  "tool-code-reviewer",
  "tool-security-reviewer",
  "tool-verifier",
] as const;

export const KONTOUR_EVALS_SOURCE = Object.freeze({
  id: "kontour-evals-results",
  schema: "kontour.console.economics",
  version: "0.1",
  sourceClass: "first-party" as const,
});

export interface KontourEvalsResultSet {
  body: string | Uint8Array;
  bodySha256: string;
  sourceRef: string;
  integrity: "content-addressed-result-set";
}

export interface KontourEvalsRunMapping {
  /** Exact model label reported by the Evals runner. */
  reportedModel: string;
  model: ModelIdentity;
  runtime: ComponentIdentity;
  adapter: ComponentIdentity | null;
  effectiveContextTokens: number | null;
  toolSurface: string[];
  hardware: HardwareProfile | null;
  workflow: ComponentIdentity;
  taskFamily: string;
  evaluator: ComponentIdentity;
  validUntil: string | null;
}

export interface KontourEvalsImportInput {
  resultSet: KontourEvalsResultSet;
  /** Exact Evals run_id to reviewed execution identity. */
  runs: Readonly<Record<string, KontourEvalsRunMapping>>;
}

export interface KontourEvalsDiagnostic {
  code: "unmapped-run" | "configured-run-missing";
  path: string;
  message: string;
}

export interface KontourEvalsImportResult {
  observations: ObservationInput[];
  diagnostics: KontourEvalsDiagnostic[];
  acquisition: {
    sourceRef: string;
    bodySha256: string;
    records: number;
  };
}

interface EvalsRecord {
  raw: Record<string, unknown>;
  runId: string;
  observedAt: string;
  model: string;
  modelTier: string;
  kitCondition: "bare" | "+kit";
  acceptance: "accepted" | "rejected";
  taskId: string;
  harnessRunId: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  wallClockSeconds: number;
  iterations: number;
  routeBacks: number;
  gateFires: number;
  caughtFalseCompletions: number;
  defectEscapes: string[];
  officialScore: number | null;
  externalSuiteId: string | null;
  runnerExecution: RunnerExecution | null;
  kitSignal: KitSignal | null;
  kitProvenance: Record<string, unknown> | null;
  pricingVersion: string | null;
}

interface RunnerExecution {
  exitCode: number | null;
  usageSource: string;
  usageComplete: boolean;
  continuationPolicy: string;
  contextPolicy: string | null;
  agentTopology: string;
  webSearchEnabled: boolean;
  turnsStarted: number;
  turnsCompleted: number;
}

interface KitSignal {
  engagementQualification: "engaged" | "invalid_engagement" | "not_applicable";
  workflowEngaged: boolean;
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

const optionalRecord = (value: unknown, path: string): Record<string, unknown> | null =>
  value === null || value === undefined ? null : record(value, path);

const text = (value: unknown, path: string): string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_TEXT_LENGTH &&
  value.trim() === value &&
  !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : fail(path, `must be a trimmed control-free string between 1 and ${MAX_TEXT_LENGTH} characters`);

const identifier = (value: unknown, path: string, maxLength = 512): string => {
  const result = text(value, path);
  if (result.length > maxLength || !/^[A-Za-z0-9._~+:/-]+$/.test(result)) {
    return fail(path, `must be a safe ASCII identifier no longer than ${maxLength} characters`);
  }
  return result;
};

const runIdentifier = (value: unknown, path: string, maxLength = 512): string => {
  const result = identifier(value, path, maxLength);
  if (result.startsWith("/") || result.startsWith("~/") || /^file:/i.test(result) || /^[A-Za-z]:[\\/]/.test(result)) {
    return fail(path, "must not be an absolute, home-relative, or file URI path");
  }
  return result;
};

const optionalPublicIdentifier = (value: unknown, path: string, maxLength = 512): string | null =>
  value === null || value === undefined ? null : runIdentifier(value, path, maxLength);

const finite = (value: unknown, path: string): number =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : fail(path, "must be a finite number");

const nonNegative = (value: unknown, path: string): number => {
  const result = finite(value, path);
  return result >= 0 ? result : fail(path, "must be non-negative");
};

const integer = (value: unknown, path: string): number => {
  const result = nonNegative(value, path);
  return Number.isSafeInteger(result) ? result : fail(path, "must be a non-negative safe integer");
};

const nullableInteger = (value: unknown, path: string): number | null =>
  value === null ? null : integer(value, path);

const optionalFinite = (value: unknown, path: string): number | null =>
  value === null || value === undefined ? null : finite(value, path);

const boolean = (value: unknown, path: string): boolean =>
  typeof value === "boolean" ? value : fail(path, "must be a boolean");

const nullableText = (value: unknown, path: string): string | null =>
  value === null ? null : text(value, path);

const timestamp = (value: unknown, path: string): string => {
  const raw = text(value, path);
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime()) || !raw.endsWith("Z")) {
    return fail(path, "must be an ISO-8601 UTC timestamp");
  }
  return parsed.toISOString();
};

const stringArray = (value: unknown, path: string): string[] => {
  if (!Array.isArray(value)) return fail(path, "must be an array");
  const result = value.map((entry, index) => text(entry, `${path}[${index}]`));
  if (new Set(result).size !== result.length) return fail(path, "must not contain duplicates");
  return result;
};

const decodeBody = (body: string | Uint8Array): { body: string; bytes: Uint8Array } => {
  if (typeof body !== "string" && !(body instanceof Uint8Array)) {
    return fail("$.resultSet.body", "must be a string or Uint8Array");
  }
  const byteLength = typeof body === "string" ? Buffer.byteLength(body, "utf8") : body.byteLength;
  if (byteLength > MAX_SOURCE_BYTES) return fail("$.resultSet.body", `exceeds ${MAX_SOURCE_BYTES} bytes`);
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("$.resultSet.body", "must be valid UTF-8");
  }
  if (typeof body === "string" && decoded !== body) {
    return fail("$.resultSet.body", "must round-trip through UTF-8 without replacement");
  }
  return { body: decoded, bytes };
};

const validateResultSet = (resultSet: KontourEvalsResultSet): string => {
  if (resultSet === null || typeof resultSet !== "object") return fail("$.resultSet", "must be an object");
  if (resultSet.integrity !== "content-addressed-result-set") {
    return fail("$.resultSet.integrity", "must cite a content-addressed Evals result set");
  }
  const { body, bytes } = decodeBody(resultSet.body);
  if (!SHA256_PATTERN.test(resultSet.bodySha256)) {
    return fail("$.resultSet.bodySha256", "must be a lowercase SHA-256 digest");
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== resultSet.bodySha256) {
    return fail("$.resultSet.bodySha256", "does not match result bytes");
  }
  if (
    typeof resultSet.sourceRef !== "string" ||
    resultSet.sourceRef.length === 0 ||
    resultSet.sourceRef.length > MAX_SOURCE_REF_LENGTH ||
    resultSet.sourceRef.trim() !== resultSet.sourceRef
  ) {
    return fail("$.resultSet.sourceRef", `must be a trimmed URI between 1 and ${MAX_SOURCE_REF_LENGTH} characters`);
  }
  if (!resultSet.sourceRef.startsWith(RESULT_SET_URN_PREFIX)) {
    return fail("$.resultSet.sourceRef", `must use the durable ${RESULT_SET_URN_PREFIX} namespace`);
  }
  const suffix = resultSet.sourceRef.slice(RESULT_SET_URN_PREFIX.length);
  if (suffix.length === 0 || !/^[A-Za-z0-9:._~-]+$/.test(suffix)) {
    return fail("$.resultSet.sourceRef", "must be a path-free, credential-free result-set URN");
  }
  return body;
};

const validateJsonTree = (root: JsonNode | undefined, errors: ParseError[], path: string): void => {
  if (root === undefined || errors.length > 0) return fail(path, "must be strict JSON");
  const pending: Array<{ node: JsonNode; depth: number }> = [{ node: root, depth: 1 }];
  let nodes = 0;
  while (pending.length > 0) {
    const { node, depth } = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_JSON_NODES) return fail(path, `contains more than ${MAX_JSON_NODES} JSON nodes`);
    if (depth > MAX_JSON_DEPTH) return fail(path, `exceeds JSON depth ${MAX_JSON_DEPTH}`);
    if (node.type === "object") {
      const keys = new Set<string>();
      for (const property of node.children ?? []) {
        const key = property.children?.[0]?.value;
        if (typeof key !== "string") return fail(path, "contains an invalid object property");
        if (keys.has(key)) return fail(path, `contains duplicate key ${key}`);
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          return fail(path, `contains forbidden key ${key}`);
        }
        keys.add(key);
      }
    }
    for (const child of node.children ?? []) pending.push({ node: child, depth: depth + 1 });
  }
};

const preflightJsonStructure = (source: string, path: string): void => {
  const scanner = createScanner(source, true);
  let depth = 0;
  let lexicalTokens = 0;
  for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
    lexicalTokens += 1;
    if (lexicalTokens > MAX_JSON_NODES) {
      return fail(path, `contains more than ${MAX_JSON_NODES} lexical JSON tokens`);
    }
    if (token === SyntaxKind.OpenBraceToken || token === SyntaxKind.OpenBracketToken) {
      depth += 1;
      if (depth > MAX_JSON_DEPTH) return fail(path, `exceeds JSON depth ${MAX_JSON_DEPTH}`);
    } else if (token === SyntaxKind.CloseBraceToken || token === SyntaxKind.CloseBracketToken) {
      depth -= 1;
    }
  }
};

const parseRecords = (body: string): Record<string, unknown>[] => {
  const records: Record<string, unknown>[] = [];
  let start = 0;
  let physicalLine = 0;
  while (start <= body.length) {
    physicalLine += 1;
    if (physicalLine > MAX_PHYSICAL_LINES) {
      return fail("$.resultSet.body", `contains more than ${MAX_PHYSICAL_LINES} physical lines`);
    }
    const newline = body.indexOf("\n", start);
    const end = newline < 0 ? body.length : newline;
    const rawLine = body.slice(start, end);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    start = newline < 0 ? body.length + 1 : newline + 1;
    if (line.trim().length === 0) continue;
    if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) {
      return fail(`$.resultSet.body:${physicalLine}`, `exceeds ${MAX_RECORD_BYTES} bytes`);
    }
    preflightJsonStructure(line, `$.resultSet.body:${physicalLine}`);
    const errors: ParseError[] = [];
    const tree = parseTree(line, errors, { allowTrailingComma: false, disallowComments: true });
    validateJsonTree(tree, errors, `$.resultSet.body:${physicalLine}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return fail(`$.resultSet.body:${physicalLine}`, "must be strict JSON");
    }
    records.push(record(parsed, `$.resultSet.body:${physicalLine}`));
    if (records.length > MAX_RECORDS) return fail("$.resultSet.body", `contains more than ${MAX_RECORDS} records`);
  }
  if (records.length === 0) return fail("$.resultSet.body", "must contain at least one record");
  return records;
};

const parseEconomics = (raw: Record<string, unknown>, path: string) => {
  const cost = record(raw.cost, `${path}.cost`);
  const time = record(raw.time, `${path}.time`);
  const inputTokens = integer(cost.input_tokens, `${path}.cost.input_tokens`);
  const outputTokens = integer(cost.output_tokens, `${path}.cost.output_tokens`);
  const totalTokens = integer(cost.total_tokens, `${path}.cost.total_tokens`);
  const cacheCreationTokens = integer(cost.cache_creation_input_tokens, `${path}.cost.cache_creation_input_tokens`);
  const cacheReadTokens = integer(cost.cache_read_input_tokens, `${path}.cost.cache_read_input_tokens`);
  if (totalTokens !== inputTokens + outputTokens) {
    return fail(`${path}.cost.total_tokens`, "must equal input_tokens + output_tokens");
  }
  if (cacheReadTokens > inputTokens) {
    return fail(`${path}.cost.cache_read_input_tokens`, "must not exceed input_tokens");
  }
  nonNegative(cost.estimated_cost_usd, `${path}.cost.estimated_cost_usd`);
  const wallClockSeconds = nonNegative(time.wall_clock_s, `${path}.time.wall_clock_s`);
  if (!Number.isSafeInteger(Math.round(wallClockSeconds * 1000))) {
    return fail(`${path}.time.wall_clock_s`, "cannot be represented as safe integer milliseconds");
  }
  return { inputTokens, outputTokens, totalTokens, cacheCreationTokens, cacheReadTokens, wallClockSeconds };
};

const parseRunnerExecution = (value: unknown, path: string): RunnerExecution | null => {
  const raw = optionalRecord(value, path);
  if (raw === null) return null;
  const result: RunnerExecution = {
    exitCode: nullableInteger(raw.codex_exit_code, `${path}.codex_exit_code`),
    usageSource: text(raw.usage_source, `${path}.usage_source`),
    usageComplete: boolean(raw.usage_complete, `${path}.usage_complete`),
    continuationPolicy: text(raw.continuation_policy, `${path}.continuation_policy`),
    contextPolicy: nullableText(raw.context_policy, `${path}.context_policy`),
    agentTopology: text(raw.agent_topology, `${path}.agent_topology`),
    webSearchEnabled: boolean(raw.web_search_enabled, `${path}.web_search_enabled`),
    turnsStarted: integer(raw.turns_started, `${path}.turns_started`),
    turnsCompleted: integer(raw.turns_completed, `${path}.turns_completed`),
  };
  if (!SUPPORTED_USAGE_SOURCES.has(result.usageSource)) {
    return fail(`${path}.usage_source`, "is not a supported Evals usage source");
  }
  if (result.usageComplete && !COMPLETE_USAGE_SOURCES.has(result.usageSource)) {
    return fail(`${path}.usage_source`, "cannot provide complete usage");
  }
  if (!CONTINUATION_POLICIES.has(result.continuationPolicy)) {
    return fail(`${path}.continuation_policy`, "is not a supported Evals continuation policy");
  }
  if (!AGENT_TOPOLOGIES.has(result.agentTopology)) {
    return fail(`${path}.agent_topology`, "must be single-agent or multi-agent-capable");
  }
  if (result.turnsCompleted > result.turnsStarted) {
    return fail(`${path}.turns_completed`, "must not exceed turns_started");
  }
  if (result.usageComplete && result.exitCode !== 0) {
    return fail(`${path}.usage_complete`, "cannot be true without a successful runner exit");
  }
  if (result.usageComplete && (result.turnsStarted === 0 || result.turnsCompleted !== result.turnsStarted)) {
    return fail(`${path}.usage_complete`, "cannot be true unless every started turn completed");
  }
  if (result.usageComplete && result.usageSource === "unavailable") {
    return fail(`${path}.usage_source`, "cannot be unavailable when usage is complete");
  }
  return result;
};

const parseKitSignal = (
  value: unknown,
  kitCondition: EvalsRecord["kitCondition"],
  path: string,
): KitSignal | null => {
  const raw = optionalRecord(value, path);
  if (raw === null) return null;
  const qualification = text(raw.engagement_qualification, `${path}.engagement_qualification`);
  if (qualification !== "engaged" && qualification !== "invalid_engagement" && qualification !== "not_applicable") {
    return fail(`${path}.engagement_qualification`, "must be engaged, invalid_engagement, or not_applicable");
  }
  const workflowEngaged = boolean(raw.workflow_engaged, `${path}.workflow_engaged`);
  if (kitCondition === "bare" && (qualification !== "not_applicable" || workflowEngaged)) {
    return fail(path, "bare runs must be not_applicable and not workflow-engaged");
  }
  if (kitCondition === "+kit" && qualification === "not_applicable") {
    return fail(`${path}.engagement_qualification`, "must qualify a +kit run as engaged or invalid_engagement");
  }
  if ((qualification === "engaged") !== workflowEngaged) {
    return fail(path, "engaged qualification and workflow_engaged must agree");
  }
  return { engagementQualification: qualification, workflowEngaged };
};

const validateTreatment = (
  kitCondition: EvalsRecord["kitCondition"],
  execution: RunnerExecution | null,
  path: string,
): void => {
  if (execution === null) return;
  const { continuationPolicy, contextPolicy } = execution;
  if (kitCondition === "bare") {
    if ((continuationPolicy !== "single-turn" && continuationPolicy !== "matched-compute") || contextPolicy !== null) {
      return fail(path, "bare runs require single-turn or matched-compute with null context policy");
    }
    return;
  }
  const valid =
    (continuationPolicy === "builder-resume" && contextPolicy === "warm") ||
    (continuationPolicy === "builder-fresh-context" && contextPolicy === "fresh");
  if (!valid) return fail(path, "+kit runs require builder-resume/warm or builder-fresh-context/fresh");
};

const validateKitProvenance = (value: unknown, path: string): Record<string, unknown> | null => {
  const provenance = optionalRecord(value, path);
  if (provenance === null) return null;
  if (provenance.schema !== "kontour.evals.kit_provenance" || provenance.version !== "1.0") {
    return fail(path, "must be kontour.evals.kit_provenance v1.0");
  }
  const source = record(provenance.source, `${path}.source`);
  const commit = text(source.commit, `${path}.source.commit`);
  if (!/^[a-f0-9]{40}$/.test(commit)) return fail(`${path}.source.commit`, "must be a full lowercase Git commit");
  if (source.dirty !== false) return fail(`${path}.source.dirty`, "must be false");
  const packageVersion = text(provenance.package_version, `${path}.package_version`);
  const runtime = record(provenance.runtime, `${path}.runtime`);
  if (text(runtime.package_version, `${path}.runtime.package_version`) !== packageVersion) {
    return fail(`${path}.runtime.package_version`, "must match package_version");
  }
  if (runtime.entrypoint !== "flow-agents") return fail(`${path}.runtime.entrypoint`, "must be flow-agents");
  for (const key of ["source_archive_sha256", "installed_tree_sha256"] as const) {
    if (!SHA256_PATTERN.test(text(runtime[key], `${path}.runtime.${key}`))) {
      return fail(`${path}.runtime.${key}`, "must be a lowercase SHA-256 digest");
    }
  }
  const roles = record(provenance.roles, `${path}.roles`);
  const roleNames = Object.keys(roles).sort(compareText);
  const expectedRoles = [...REQUIRED_KIT_ROLES].sort(compareText);
  if (roleNames.length !== expectedRoles.length || roleNames.some((role, index) => role !== expectedRoles[index])) {
    return fail(`${path}.roles`, "must contain exactly the five supported Builder Kit roles");
  }
  for (const role of REQUIRED_KIT_ROLES) {
    const assignment = record(roles[role], `${path}.roles.${role}`);
    text(assignment.model, `${path}.roles.${role}.model`);
    text(assignment.reasoning_effort, `${path}.roles.${role}.reasoning_effort`);
  }
  return provenance;
};

const parseRecord = (raw: Record<string, unknown>, index: number): EvalsRecord => {
  const path = `$[${index}]`;
  if (raw.schema !== KONTOUR_EVALS_SOURCE.schema) return fail(`${path}.schema`, `must be ${KONTOUR_EVALS_SOURCE.schema}`);
  if (raw.version !== KONTOUR_EVALS_SOURCE.version) return fail(`${path}.version`, `must be ${KONTOUR_EVALS_SOURCE.version}`);
  const iterations = record(raw.iterations, `${path}.iterations`);
  const defects = record(raw.defects, `${path}.defects`);
  const kitCondition = raw.kit_condition === "bare" || raw.kit_condition === "+kit"
    ? raw.kit_condition
    : fail(`${path}.kit_condition`, "must be bare or +kit");
  const acceptance = raw.acceptance_label === "accepted" || raw.acceptance_label === "rejected"
    ? raw.acceptance_label
    : fail(`${path}.acceptance_label`, "must be accepted or rejected");
  const modelTier = raw.model_tier === "small" || raw.model_tier === "large"
    ? raw.model_tier
    : fail(`${path}.model_tier`, "must be small or large");
  const economics = parseEconomics(raw, path);
  const runnerExecution = parseRunnerExecution(raw.runner_execution, `${path}.runner_execution`);
  validateTreatment(kitCondition, runnerExecution, `${path}.runner_execution`);
  const kitSignal = parseKitSignal(raw.kit_signal, kitCondition, `${path}.kit_signal`);
  const verificationVerdict = text(defects.verification_verdict, `${path}.defects.verification_verdict`);
  const expectedVerdict = acceptance === "accepted" ? "PASS" : "FAIL";
  if (verificationVerdict !== expectedVerdict) {
    return fail(`${path}.defects.verification_verdict`, `must be ${expectedVerdict} for ${acceptance}`);
  }
  return {
    raw,
    runId: runIdentifier(raw.run_id, `${path}.run_id`),
    observedAt: timestamp(raw.at, `${path}.at`),
    model: identifier(raw.model, `${path}.model`),
    modelTier,
    kitCondition,
    acceptance,
    taskId: runIdentifier(raw.task_id, `${path}.task_id`),
    harnessRunId: identifier(raw.harness_run_id, `${path}.harness_run_id`),
    ...economics,
    iterations: integer(iterations.count, `${path}.iterations.count`),
    routeBacks: integer(iterations.route_backs, `${path}.iterations.route_backs`),
    gateFires: integer(defects.gate_fires, `${path}.defects.gate_fires`),
    caughtFalseCompletions: integer(defects.caught_false_completions, `${path}.defects.caught_false_completions`),
    defectEscapes: stringArray(raw.defect_escapes, `${path}.defect_escapes`),
    officialScore: optionalFinite(raw.official_score, `${path}.official_score`),
    externalSuiteId: optionalPublicIdentifier(raw.external_suite_id, `${path}.external_suite_id`),
    runnerExecution,
    kitSignal,
    kitProvenance: validateKitProvenance(raw.kit_provenance, `${path}.kit_provenance`),
    pricingVersion: optionalPublicIdentifier(raw.pricing_version, `${path}.pricing_version`, 128),
  };
};

const workflowCondition = (item: EvalsRecord): string => {
  const execution = item.runnerExecution;
  return JSON.stringify({
    kitCondition: item.kitCondition,
    engagementQualification: item.kitSignal?.engagementQualification ?? null,
    continuationPolicy: execution?.continuationPolicy ?? null,
    contextPolicy: execution?.contextPolicy ?? null,
    agentTopology: execution?.agentTopology ?? null,
    webSearchEnabled: execution?.webSearchEnabled ?? null,
  });
};

const usageCompleteness = (item: EvalsRecord): "complete" | "partial" | "unknown" => {
  if (item.runnerExecution === null) return "unknown";
  if (item.runnerExecution.usageComplete) return "complete";
  return item.runnerExecution.usageSource !== "unavailable" || item.totalTokens > 0 ? "partial" : "unknown";
};

const attributionEligible = (item: EvalsRecord): boolean =>
  item.kitCondition === "bare" ||
  (item.kitSignal?.engagementQualification === "engaged" && item.kitProvenance !== null);

const outcomeFor = (item: EvalsRecord): ObservationInput["outcome"] => {
  if (item.runnerExecution === null) {
    return { status: "invalid", reason: "record omitted runner execution evidence" };
  }
  if (item.runnerExecution?.usageSource === "dry-run") {
    return { status: "invalid", reason: "runner reported a dry-run without model execution" };
  }
  if (item.runnerExecution !== null && item.runnerExecution.exitCode === null) {
    return { status: "invalid", reason: "runner execution omitted exit evidence" };
  }
  const exitCode = item.runnerExecution?.exitCode;
  if (exitCode !== undefined && exitCode !== null && exitCode !== 0) {
    return { status: "invalid", reason: `runner execution exited with code ${exitCode}` };
  }
  return { status: item.acceptance, reason: item.acceptance === "rejected" ? "independent grader rejected the result" : null };
};

const measurementsFor = (
  item: EvalsRecord,
  completeness: "complete" | "partial" | "unknown",
  eligible: boolean,
  invalid: boolean,
): ObservationInput["measurements"] => {
  const key = (name: string): string => `kontour.evals.${invalid ? "diagnostic." : ""}${name}`;
  const measurements: ObservationInput["measurements"] = [
    { key: key("grader.accepted"), kind: "sample", value: item.acceptance === "accepted" },
    { key: "kontour.evals.attribution_eligible", kind: "sample", value: eligible },
    { key: "kontour.evals.model_tier", kind: "sample", value: item.modelTier },
    { key: key("defect_escapes"), kind: "sample", value: item.defectEscapes.length, unit: "defects" },
    { key: key("gate_fires"), kind: "sample", value: item.gateFires, unit: "gates" },
    { key: key("route_backs"), kind: "sample", value: item.routeBacks, unit: "route-backs" },
    { key: key("iterations"), kind: "sample", value: item.iterations, unit: "iterations" },
    { key: key("caught_false_completions"), kind: "sample", value: item.caughtFalseCompletions, unit: "defects" },
  ];
  if (item.runnerExecution !== null) {
    measurements.push({
      key: key("runner_turns_completed"),
      kind: "sample",
      value: item.runnerExecution.turnsCompleted,
      unit: "turns",
    });
  }
  if (item.kitCondition === "+kit") {
    measurements.push({
      key: key("kit.workflow_engaged"),
      kind: "sample",
      value: item.kitSignal?.workflowEngaged === true,
    });
  }
  if (item.officialScore !== null) {
    measurements.push({ key: key("official_score"), kind: "sample", value: item.officialScore });
  }
  if (completeness === "complete") {
    measurements.push(
      { key: "kontour.evals.cache_creation_input_tokens", kind: "sample", value: item.cacheCreationTokens, unit: "tokens" },
      { key: "kontour.evals.cache_read_input_tokens", kind: "sample", value: item.cacheReadTokens, unit: "tokens" },
    );
  }
  if (item.pricingVersion !== null) {
    measurements.push({ key: key("pricing_version"), kind: "sample", value: item.pricingVersion });
  }
  return measurements;
};

const evidenceFor = (
  item: EvalsRecord,
  resultSet: KontourEvalsResultSet,
): ObservationInput["evidence"] => {
  const recordDigest = sha256(item.raw);
  const graderDigest = sha256({
    recordDigest,
    acceptanceLabel: item.acceptance,
    defectEscapes: item.defectEscapes,
    defects: item.raw.defects,
    officialScore: item.officialScore,
  });
  const evidence: ObservationInput["evidence"] = [
    {
      id: `kontour-evals-result-set:${resultSet.bodySha256}`,
      kind: "content-addressed-result-set",
      uri: resultSet.sourceRef,
      digest: { algorithm: "sha256", value: resultSet.bodySha256 },
      observedAt: item.observedAt,
    },
    {
      id: `kontour-evals-record:${recordDigest}`,
      kind: "economics-record",
      uri: `urn:kontour:evals:record:sha256:${recordDigest}`,
      digest: { algorithm: "sha256", value: recordDigest },
      observedAt: item.observedAt,
    },
    {
      id: `kontour-evals-grader:${graderDigest}`,
      kind: "independent-grader-verdict",
      uri: `urn:kontour:evals:grader:sha256:${graderDigest}`,
      digest: { algorithm: "sha256", value: graderDigest },
      observedAt: item.observedAt,
    },
  ];
  if (item.kitProvenance !== null) {
    const digest = sha256(item.kitProvenance);
    evidence.push({
      id: `kontour-evals-kit-provenance:${digest}`,
      kind: "builder-kit-provenance",
      uri: `urn:kontour:evals:kit-provenance:sha256:${digest}`,
      digest: { algorithm: "sha256", value: digest },
      observedAt: item.observedAt,
    });
  }
  return evidence;
};

const uncertaintyFor = (
  item: EvalsRecord,
  completeness: "complete" | "partial" | "unknown",
  eligible: boolean,
  invalid: boolean,
): ObservationInput["uncertainty"] => {
  const gaps = [
    "a single Evals task result does not establish behavior outside its task and execution profile",
    "the Evals v0.1 record does not prove cost completeness; estimated cost remains retrievable only from the source record",
  ];
  if (completeness !== "complete") gaps.push(`token accounting is ${completeness}`);
  if (invalid) gaps.push("runner execution was invalid; result metrics are diagnostic-only");
  if (!eligible && item.kitCondition === "+kit") {
    gaps.push("Builder Kit engagement or provenance was insufficient, so this run is not attributable to the kit");
  }
  if (item.runnerExecution === null) gaps.push("legacy record omits explicit runner execution metadata");
  return {
    level: completeness === "complete" && eligible ? "low" : item.runnerExecution === null ? "high" : "moderate",
    basis: [
      "outcome comes from the Evals independent grader rather than the evaluated agent",
      "model and execution identity come from an exact reviewed run mapping",
      "the source record is retained through content and field-level evidence digests",
    ],
    gaps,
  };
};

const observationFor = (
  item: EvalsRecord,
  mapping: KontourEvalsRunMapping,
  resultSet: KontourEvalsResultSet,
): ObservationInput => {
  if (item.model !== mapping.reportedModel) {
    return fail(`$.runs.${item.runId}.reportedModel`, `does not match record model ${item.model}`);
  }
  const completeness = usageCompleteness(item);
  const outcome = outcomeFor(item);
  const invalid = outcome?.status === "invalid";
  const eligible = !invalid && attributionEligible(item);
  return validateObservation({
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    kind: "evaluation",
    model: mapping.model,
    execution: {
      kind: "exact",
      runtime: mapping.runtime,
      adapter: mapping.adapter,
      effectiveContextTokens: mapping.effectiveContextTokens,
      toolSurface: mapping.toolSurface,
      hardware: mapping.hardware,
      workflow: {
        id: mapping.workflow.id,
        version: mapping.workflow.version,
        condition: workflowCondition(item),
      },
    },
    task: {
      family: mapping.taskFamily,
      suite: item.externalSuiteId ?? "kontour.evals",
      taskId: item.taskId,
      evaluator: mapping.evaluator,
    },
    measurements: measurementsFor(item, completeness, eligible, invalid),
    outcome,
    usage: {
      inputTokens: item.inputTokens,
      outputTokens: item.outputTokens,
      reasoningTokens: null,
      totalTokens: item.totalTokens,
      completeness,
      modelCalls: null,
      wallTimeMs: Math.round(item.wallClockSeconds * 1000),
    },
    sourceClass: "first-party",
    evidence: evidenceFor(item, resultSet),
    freshness: { observedAt: item.observedAt, validUntil: mapping.validUntil },
    uncertainty: uncertaintyFor(item, completeness, eligible, invalid),
  });
};

export const importKontourEvalsResults = (
  input: KontourEvalsImportInput,
): KontourEvalsImportResult => {
  const body = validateResultSet(input.resultSet);
  if (input.runs === null || typeof input.runs !== "object" || Array.isArray(input.runs)) {
    return fail("$.runs", "must be an exact run_id mapping");
  }
  const records = parseRecords(body).map(parseRecord);
  const runIds = new Set<string>();
  records.forEach((item, index) => {
    if (runIds.has(item.runId)) return fail(`$[${index}].run_id`, `duplicates run ${item.runId}`);
    runIds.add(item.runId);
  });
  const observations: ObservationInput[] = [];
  const diagnostics: KontourEvalsDiagnostic[] = [];
  let normalizedReferenceBytes = 0;
  records.forEach((item, index) => {
    if (!Object.prototype.hasOwnProperty.call(input.runs, item.runId)) {
      diagnostics.push({
        code: "unmapped-run",
        path: `$[${index}]`,
        message: `Skipped unmapped Evals run ${item.runId}`,
      });
      return;
    }
    const mapping = input.runs[item.runId];
    if (mapping === null || typeof mapping !== "object" || Array.isArray(mapping)) {
      return fail(`$.runs.${item.runId}`, "must be a reviewed model and execution mapping");
    }
    const observation = observationFor(item, mapping, input.resultSet);
    normalizedReferenceBytes += observation.evidence.reduce(
      (total, evidence) => total + Buffer.byteLength(evidence.id, "utf8") + Buffer.byteLength(evidence.uri ?? "", "utf8"),
      0,
    );
    if (normalizedReferenceBytes > MAX_NORMALIZED_REFERENCE_BYTES) {
      return fail("$.resultSet.body", `expands beyond ${MAX_NORMALIZED_REFERENCE_BYTES} bytes of evidence references`);
    }
    observations.push(observation);
  });
  Object.keys(input.runs).sort(compareText).forEach((runId) => {
    if (!runIds.has(runId)) {
      diagnostics.push({
        code: "configured-run-missing",
        path: `$.runs.${runId}`,
        message: `Configured Evals run ${runId} is absent from the result set`,
      });
    }
  });
  observations.sort((left, right) => compareText(left.evidence[1].id, right.evidence[1].id));
  return {
    observations,
    diagnostics,
    acquisition: {
      sourceRef: input.resultSet.sourceRef,
      bodySha256: input.resultSet.bodySha256,
      records: records.length,
    },
  };
};
