import { canonicalJson } from "./canonical.js";
import type { ExecutionProfile, ExecutionScope } from "./types.js";

export type ObservationExecutionScopeKind = "global" | "exact" | "partial";

export interface ExecutionApplicabilitySummary {
  matchedKinds: ObservationExecutionScopeKind[];
  assertedDimensions: string[];
  wildcardedDimensions: string[];
  mismatchedDimensions: string[];
}

export interface ExecutionScopeEvaluation {
  matches: boolean;
  kind: ObservationExecutionScopeKind;
  asserted: string[];
  wildcarded: string[];
  mismatched: string[];
}

type MutableEvaluation = Omit<ExecutionScopeEvaluation, "matches" | "kind">;

const compare = (result: MutableEvaluation, dimension: string, expected: unknown, actual: unknown): void => {
  result.asserted.push(dimension);
  if (canonicalJson(expected) !== canonicalJson(actual)) result.mismatched.push(dimension);
};

const compareOptional = (result: MutableEvaluation, dimension: string, expected: unknown, actual: unknown): void => {
  if (expected === null) result.wildcarded.push(dimension);
  else compare(result, dimension, expected, actual);
};

const classifyOptionalAssertion = (result: MutableEvaluation, dimension: string, expected: unknown): void => {
  (expected === null ? result.wildcarded : result.asserted).push(dimension);
};

const compareComponent = (
  result: MutableEvaluation,
  name: "adapter" | "runtime",
  expected: { id: string; version: string | null },
  actual: { id: string; version: string | null } | null,
): void => {
  if (actual === null) {
    result.asserted.push(`${name}.id`);
    classifyOptionalAssertion(result, `${name}.version`, expected.version);
    result.mismatched.push(name);
    return;
  }
  compare(result, `${name}.id`, expected.id, actual.id);
  compareOptional(result, `${name}.version`, expected.version, actual.version);
};

const compareHardware = (
  result: MutableEvaluation,
  expected: NonNullable<ExecutionScope["hardware"]>,
  actual: ExecutionProfile["hardware"],
): void => {
  if (actual === null) {
    result.asserted.push("hardware.class");
    classifyOptionalAssertion(result, "hardware.accelerator", expected.accelerator);
    classifyOptionalAssertion(result, "hardware.memoryBytes", expected.memoryBytes);
    result.mismatched.push("hardware");
    return;
  }
  compare(result, "hardware.class", expected.class, actual.class);
  compareOptional(result, "hardware.accelerator", expected.accelerator, actual.accelerator);
  compareOptional(result, "hardware.memoryBytes", expected.memoryBytes, actual.memoryBytes);
};

const compareWorkflow = (
  result: MutableEvaluation,
  expected: NonNullable<ExecutionScope["workflow"]>,
  actual: ExecutionProfile["workflow"],
): void => {
  if (actual === null) {
    result.asserted.push("workflow.id");
    classifyOptionalAssertion(result, "workflow.version", expected.version);
    classifyOptionalAssertion(result, "workflow.condition", expected.condition);
    result.mismatched.push("workflow");
    return;
  }
  compare(result, "workflow.id", expected.id, actual.id);
  compareOptional(result, "workflow.version", expected.version, actual.version);
  compareOptional(result, "workflow.condition", expected.condition, actual.condition);
};

const exactDimensions: Array<keyof ExecutionProfile> = [
  "runtime",
  "adapter",
  "effectiveContextTokens",
  "toolSurface",
  "hardware",
  "workflow",
];

export const evaluateExecutionScope = (
  scope: ExecutionScope | null,
  candidate: ExecutionProfile,
): ExecutionScopeEvaluation => {
  if (scope === null) {
    return { matches: true, kind: "global", asserted: [], wildcarded: ["execution"], mismatched: [] };
  }
  if (scope.kind === "exact") {
    const mismatched = exactDimensions.filter((dimension) =>
      canonicalJson(scope[dimension]) !== canonicalJson(candidate[dimension]));
    return { matches: mismatched.length === 0, kind: "exact", asserted: [...exactDimensions], wildcarded: [], mismatched };
  }

  const result: MutableEvaluation = { asserted: [], wildcarded: [], mismatched: [] };
  compareComponent(result, "runtime", scope.runtime, candidate.runtime);
  if (scope.adapter === null) result.wildcarded.push("adapter");
  else compareComponent(result, "adapter", scope.adapter, candidate.adapter);
  compareOptional(result, "effectiveContextTokens", scope.effectiveContextTokens, candidate.effectiveContextTokens);
  compareOptional(result, "toolSurface", scope.toolSurface, candidate.toolSurface);
  if (scope.hardware === null) result.wildcarded.push("hardware");
  else compareHardware(result, scope.hardware, candidate.hardware);
  if (scope.workflow === null) result.wildcarded.push("workflow");
  else compareWorkflow(result, scope.workflow, candidate.workflow);
  return { matches: result.mismatched.length === 0, kind: "partial", ...result };
};

export const summarizeExecutionApplicability = (
  evaluations: ExecutionScopeEvaluation[],
): ExecutionApplicabilitySummary => ({
  matchedKinds: [...new Set(evaluations.filter((item) => item.matches).map((item) => item.kind))].sort(),
  assertedDimensions: [...new Set(evaluations.flatMap((item) => item.asserted))].sort(),
  wildcardedDimensions: [...new Set(evaluations.flatMap((item) => item.wildcarded))].sort(),
  mismatchedDimensions: [...new Set(evaluations.filter((item) => !item.matches).flatMap((item) => item.mismatched))].sort(),
});
