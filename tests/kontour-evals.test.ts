import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  BearingError,
  compileCatalog,
  importKontourEvalsResults,
  type KontourEvalsImportInput,
  type KontourEvalsRunMapping,
} from "../src/index.js";

const fixture = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "tests", "fixtures", "kontour-evals-results.jsonl"),
  "utf8",
);

const resultSet = (body: string | Uint8Array = fixture) => ({
  body,
  bodySha256: createHash("sha256").update(body).digest("hex"),
  sourceRef: "urn:kontour:evals:result-set:matrix",
  integrity: "content-addressed-result-set" as const,
});

const mapping = (reportedModel = "qwen3-coder:30b"): KontourEvalsRunMapping => ({
  reportedModel,
  model: { id: "qwen/qwen3-coder-30b", revision: "qwen3-coder", quantization: "q4_k_m" },
  runtime: { id: "ollama", version: "0.12.0" },
  adapter: { id: "codex-cli", version: "0.142.5" },
  effectiveContextTokens: 32_768,
  toolSurface: ["shell", "apply_patch", "subagents"],
  hardware: { class: "local-workstation", accelerator: "apple-gpu", memoryBytes: 137_438_953_472 },
  workflow: { id: "kontour.evals.matrix", version: "b5b2526" },
  taskFamily: "software-engineering",
  evaluator: { id: "kontour.evals.independent-grader", version: "b5b2526" },
  validUntil: "2027-07-18T00:00:00.000Z",
});

const runIds = [
  "matrix/task-1/small-bare",
  "matrix/task-1/small-kit",
  "matrix/task-2/small-kit-rejected",
  "matrix/task-3/small-kit-timeout",
  "matrix/task-4/small-kit-not-engaged",
];

const runs = Object.fromEntries(runIds.map((runId) => [runId, mapping()]));

const importFixture = (overrides: Partial<KontourEvalsImportInput> = {}) =>
  importKontourEvalsResults({ resultSet: resultSet(), runs, ...overrides });

const mutateRun = (runId: string, mutate: (record: Record<string, any>) => void): string =>
  fixture.trim().split("\n").map((line) => {
    const item = JSON.parse(line) as Record<string, any>;
    if (item.run_id === runId) mutate(item);
    return JSON.stringify(item);
  }).join("\n") + "\n";

const byRun = (result: ReturnType<typeof importFixture>, runId: string) =>
  result.observations.find((observation) => {
    const taskId = runId.split("/")[1];
    const kitCondition = runId.endsWith("small-bare") ? "bare" : "+kit";
    return observation.task?.taskId === taskId &&
      observation.execution?.workflow?.condition?.includes(`"kitCondition":"${kitCondition}"`);
  })!;

test("imports accepted, rejected, invalid, and unattributed Evals outcomes without conflating them", () => {
  const result = importFixture();
  assert.equal(result.observations.length, 5);
  assert.deepEqual(result.diagnostics, []);

  assert.equal(byRun(result, runIds[0]).outcome?.status, "accepted");
  assert.equal(byRun(result, runIds[1]).outcome?.status, "accepted");
  assert.equal(byRun(result, runIds[2]).outcome?.status, "rejected");
  assert.equal(byRun(result, runIds[3]).outcome?.status, "invalid");

  const notEngaged = byRun(result, runIds[4]);
  assert.equal(notEngaged.outcome?.status, "accepted");
  assert.equal(
    notEngaged.measurements.find((item) => item.key === "kontour.evals.attribution_eligible")?.value,
    false,
  );
  assert.match(notEngaged.uncertainty.gaps.join(" "), /not attributable/);
});

test("preserves reviewed identity, execution treatment, evaluator, and first-party provenance", () => {
  const result = importFixture();
  const kit = byRun(result, runIds[1]);
  assert.deepEqual(kit.model, mapping().model);
  assert.deepEqual(kit.execution?.runtime, mapping().runtime);
  assert.deepEqual(kit.execution?.adapter, mapping().adapter);
  assert.equal(kit.execution?.effectiveContextTokens, 32_768);
  assert.deepEqual(kit.execution?.toolSurface, mapping().toolSurface);
  assert.match(kit.execution?.workflow?.condition ?? "", /"kitCondition":"\+kit"/);
  assert.match(kit.execution?.workflow?.condition ?? "", /"engagementQualification":"engaged"/);
  assert.match(kit.execution?.workflow?.condition ?? "", /"contextPolicy":"fresh"/);
  assert.deepEqual(kit.task?.evaluator, mapping().evaluator);
  assert.equal(kit.sourceClass, "first-party");
  assert.equal(kit.evidence.some((item) => item.kind === "content-addressed-result-set"), true);
  assert.equal(kit.evidence.some((item) => item.kind === "independent-grader-verdict"), true);
  assert.equal(kit.evidence.some((item) => item.kind === "builder-kit-provenance"), true);
});

test("partial timeout usage remains partial and cannot become a cost observation", () => {
  const timeout = byRun(importFixture(), runIds[3]);
  assert.equal(timeout.usage?.completeness, "partial");
  assert.equal(timeout.usage?.inputTokens, 80);
  assert.equal(timeout.usage?.totalTokens, 88);
  assert.equal(timeout.measurements.some((item) => item.key === "kontour.evals.estimated_cost"), false);
  assert.equal(timeout.measurements.some((item) => item.key === "kontour.evals.cache_read_input_tokens"), false);
  assert.equal(timeout.measurements.some((item) => item.key === "kontour.evals.grader.accepted"), false);
  assert.equal(timeout.measurements.some((item) => item.key === "kontour.evals.diagnostic.grader.accepted"), true);
  assert.equal(timeout.measurements.find((item) => item.key === "kontour.evals.attribution_eligible")?.value, false);
  assert.match(timeout.outcome?.reason ?? "", /143/);

  const complete = byRun(importFixture(), runIds[0]);
  assert.equal(complete.usage?.completeness, "complete");
  assert.equal(complete.usage?.modelCalls, null);
  assert.equal(complete.measurements.some((item) => item.key === "kontour.evals.runner_turns_completed"), true);
  assert.equal(complete.measurements.some((item) => item.key === "kontour.evals.estimated_cost"), false);
  assert.match(complete.uncertainty.gaps.join(" "), /does not prove cost completeness/);
});

test("re-import is deterministic and duplicate catalog input remains detectable", () => {
  const first = importFixture();
  const second = importFixture();
  assert.deepEqual(second, first);
  const firstCatalog = compileCatalog(first.observations, { asOf: "2026-07-18T21:00:00.000Z" });
  const secondCatalog = compileCatalog(second.observations, { asOf: "2026-07-18T21:00:00.000Z" });
  assert.equal(secondCatalog.digest, firstCatalog.digest);
  assert.throws(
    () => compileCatalog([...first.observations, first.observations[0]], { asOf: "2026-07-18T21:00:00.000Z" }),
    (error: unknown) => error instanceof BearingError && error.code === "DUPLICATE_OBSERVATION",
  );
});

test("requires exact run and model mappings rather than fuzzy identity inference", () => {
  const oneRun = { [runIds[0]]: mapping() };
  const result = importFixture({ runs: oneRun });
  assert.equal(result.observations.length, 1);
  assert.equal(result.diagnostics.filter((item) => item.code === "unmapped-run").length, 4);

  assert.throws(
    () => importFixture({ runs: { [runIds[0]]: mapping("Qwen 30B") } }),
    (error: unknown) => error instanceof BearingError && error.path.includes("reportedModel"),
  );

  const inherited = Object.create({ [runIds[0]]: mapping() });
  const inheritedResult = importFixture({ runs: inherited });
  assert.equal(inheritedResult.observations.length, 0);
});

test("rejects tampered, duplicate-key, over-deep, and inconsistent result records", () => {
  assert.throws(
    () => importFixture({ resultSet: { ...resultSet(), bodySha256: "0".repeat(64) } }),
    (error: unknown) => error instanceof BearingError && error.path === "$.resultSet.bodySha256",
  );

  const duplicate = fixture.replace('"run_id":"matrix/task-1/small-bare"', '"run_id":"matrix/task-1/small-bare","run_id":"duplicate"');
  assert.throws(
    () => importFixture({ resultSet: resultSet(duplicate) }),
    (error: unknown) => error instanceof BearingError && /duplicate key run_id/.test(error.message),
  );

  const inconsistent = fixture.replace('"total_tokens":120', '"total_tokens":121');
  assert.throws(
    () => importFixture({ resultSet: resultSet(inconsistent) }),
    (error: unknown) => error instanceof BearingError && error.path.endsWith("cost.total_tokens"),
  );

  const deep = `${'{"x":'.repeat(65)}0${"}".repeat(65)}`;
  assert.throws(
    () => importFixture({ resultSet: resultSet(deep) }),
    (error: unknown) => error instanceof BearingError && /exceeds JSON depth/.test(error.message),
  );

  const stackDepthProbe = `${"[".repeat(4_096)}0${"]".repeat(4_096)}`;
  assert.throws(
    () => importFixture({ resultSet: resultSet(stackDepthProbe) }),
    (error: unknown) => error instanceof BearingError && /exceeds JSON depth/.test(error.message),
  );

  const nodeBudgetProbe = `[${"0,".repeat(100_001)}0]`;
  assert.throws(
    () => importFixture({ resultSet: resultSet(nodeBudgetProbe) }),
    (error: unknown) => error instanceof BearingError && /lexical JSON tokens/.test(error.message),
  );

  const malformedScalarBudgetProbe = `[${"0 ".repeat(100_001)}]`;
  assert.throws(
    () => importFixture({ resultSet: resultSet(malformedScalarBudgetProbe) }),
    (error: unknown) => error instanceof BearingError && /lexical JSON tokens/.test(error.message),
  );

  const adjacentNumericBudgetProbe = `[1${"-1".repeat(100_001)}]`;
  assert.throws(
    () => importFixture({ resultSet: resultSet(adjacentNumericBudgetProbe) }),
    (error: unknown) => error instanceof BearingError && /lexical JSON tokens/.test(error.message),
  );
});

test("maps missing exit evidence to invalid without laundering complete usage", () => {
  const body = mutateRun(runIds[0], (item) => {
    item.runner_execution.codex_exit_code = null;
    item.runner_execution.usage_complete = false;
    item.runner_execution.usage_source = "unavailable";
  });
  const imported = importFixture({ resultSet: resultSet(body) });
  const observation = byRun(imported, runIds[0]);
  assert.equal(observation.outcome?.status, "invalid");
  assert.match(observation.outcome?.reason ?? "", /omitted exit evidence/);
  assert.equal(observation.usage?.completeness, "partial");
  assert.equal(observation.measurements.some((item) => item.key === "kontour.evals.grader.accepted"), false);
});

test("records without runner execution evidence are invalid and diagnostic-only", () => {
  const body = mutateRun(runIds[1], (item) => {
    item.runner_execution = null;
  });
  const observation = byRun(importFixture({ resultSet: resultSet(body) }), runIds[1]);
  assert.equal(observation.outcome?.status, "invalid");
  assert.equal(observation.usage?.completeness, "unknown");
  assert.equal(observation.measurements.some((item) => item.key === "kontour.evals.grader.accepted"), false);
  assert.equal(
    observation.measurements.find((item) => item.key === "kontour.evals.attribution_eligible")?.value,
    false,
  );
});

test("dry-run records remain diagnostic-only even when the grader accepts the tree", () => {
  const body = mutateRun(runIds[0], (item) => {
    item.runner_execution.usage_source = "dry-run";
    item.runner_execution.usage_complete = false;
  });
  const observation = byRun(importFixture({ resultSet: resultSet(body) }), runIds[0]);
  assert.equal(observation.outcome?.status, "invalid");
  assert.match(observation.outcome?.reason ?? "", /dry-run/);
  assert.equal(observation.measurements.some((item) => item.key === "kontour.evals.grader.accepted"), false);
  assert.equal(
    observation.measurements.find((item) => item.key === "kontour.evals.diagnostic.grader.accepted")?.value,
    true,
  );
  assert.equal(
    observation.measurements.find((item) => item.key === "kontour.evals.attribution_eligible")?.value,
    false,
  );
});

test("rejects contradictory turn, engagement, usage-source, and provenance claims", () => {
  const incompleteTurns = mutateRun(runIds[0], (item) => {
    item.runner_execution.turns_started = 2;
  });
  assert.throws(
    () => importFixture({ resultSet: resultSet(incompleteTurns) }),
    (error: unknown) => error instanceof BearingError && /every started turn completed/.test(error.message),
  );

  const contradictoryEngagement = mutateRun(runIds[1], (item) => {
    item.kit_signal.workflow_engaged = false;
  });
  assert.throws(
    () => importFixture({ resultSet: resultSet(contradictoryEngagement) }),
    (error: unknown) => error instanceof BearingError && /must agree/.test(error.message),
  );

  const unsupportedUsage = mutateRun(runIds[0], (item) => {
    item.runner_execution.usage_source = "claimed-complete";
  });
  assert.throws(
    () => importFixture({ resultSet: resultSet(unsupportedUsage) }),
    (error: unknown) => error instanceof BearingError && /supported Evals usage source/.test(error.message),
  );

  const partialUsageClaimedComplete = mutateRun(runIds[0], (item) => {
    item.runner_execution.usage_source = "codex-rollout-token-count";
  });
  assert.throws(
    () => importFixture({ resultSet: resultSet(partialUsageClaimedComplete) }),
    (error: unknown) => error instanceof BearingError && /cannot provide complete usage/.test(error.message),
  );

  const invalidTreatment = mutateRun(runIds[1], (item) => {
    item.runner_execution.continuation_policy = "single-turn";
    item.runner_execution.context_policy = null;
  });
  assert.throws(
    () => importFixture({ resultSet: resultSet(invalidTreatment) }),
    (error: unknown) => error instanceof BearingError && /\+kit runs require/.test(error.message),
  );

  const incompleteProvenance = mutateRun(runIds[1], (item) => {
    item.kit_provenance = { schema: "kontour.evals.kit_provenance", version: "1.0" };
  });
  assert.throws(
    () => importFixture({ resultSet: resultSet(incompleteProvenance) }),
    (error: unknown) => error instanceof BearingError && error.path.includes("kit_provenance.source"),
  );

  const extraRole = mutateRun(runIds[1], (item) => {
    item.kit_provenance.roles["unexpected-role"] = { model: "x", reasoning_effort: "low" };
  });
  assert.throws(
    () => importFixture({ resultSet: resultSet(extraRole) }),
    (error: unknown) => error instanceof BearingError && /exactly the five supported/.test(error.message),
  );
});

test("rejects prototype keys, unsafe references, and physical-line amplification", () => {
  const prototypeKey = fixture.replace(
    '"schema":"kontour.console.economics"',
    '"__proto__":{"schema":"forged"},"schema":"kontour.console.economics"',
  );
  assert.throws(
    () => importFixture({ resultSet: resultSet(prototypeKey) }),
    (error: unknown) => error instanceof BearingError && /forbidden key __proto__/.test(error.message),
  );

  assert.throws(
    () => importFixture({ resultSet: { ...resultSet(), sourceRef: "file:///Users/alice/private/results.jsonl" } }),
    (error: unknown) => error instanceof BearingError && error.path === "$.resultSet.sourceRef",
  );

  const amplified = `${"\n".repeat(20_001)}${fixture.split("\n")[0]}\n`;
  assert.throws(
    () => importFixture({ resultSet: resultSet(amplified) }),
    (error: unknown) => error instanceof BearingError && /physical lines/.test(error.message),
  );

  const oversizedId = mutateRun(runIds[0], (item) => {
    item.run_id = "x".repeat(513);
  });
  assert.throws(
    () => importFixture({ resultSet: resultSet(oversizedId) }),
    (error: unknown) => error instanceof BearingError && error.path.endsWith("run_id"),
  );

  const absolutePathId = mutateRun(runIds[0], (item) => {
    item.run_id = "/Users/alice/private/results";
  });
  assert.throws(
    () => importFixture({ resultSet: resultSet(absolutePathId) }),
    (error: unknown) => error instanceof BearingError && /must not be an absolute/.test(error.message),
  );

  for (const field of ["task_id", "external_suite_id", "pricing_version"]) {
    const pathShaped = mutateRun(runIds[0], (item) => {
      item[field] = "/Users/alice/private/value";
    });
    assert.throws(
      () => importFixture({ resultSet: resultSet(pathShaped) }),
      (error: unknown) => error instanceof BearingError && /must not be an absolute/.test(error.message),
      `${field} must not disclose an absolute path`,
    );
  }

  const invalidTier = mutateRun(runIds[0], (item) => {
    item.model_tier = "/Users/alice/private/tier";
  });
  assert.throws(
    () => importFixture({ resultSet: resultSet(invalidTier) }),
    (error: unknown) => error instanceof BearingError && /must be small or large/.test(error.message),
  );
});
