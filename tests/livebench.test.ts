import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildSnapshotSourceRef, parseSnapshotSourceRef } from "@kontourai/forage/fetch";
import {
  LIVEBENCH_SOURCE,
  BearingError,
  compileCatalog,
  importLiveBenchSnapshots,
  liveBenchSourceId,
  liveBenchSourceUrl,
  type LiveBenchArtifact,
  type LiveBenchImportInput,
  type LiveBenchTrustedSnapshot,
} from "../src/index.js";

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "tests", "fixtures");
const table = readFileSync(path.join(fixtureRoot, "livebench-table.csv"), "utf8");
const categories = readFileSync(path.join(fixtureRoot, "livebench-categories.json"), "utf8");
const release = "2026-06-25";

const snapshot = (
  artifact: LiveBenchArtifact,
  body: string | Uint8Array = artifact === "table" ? table : categories,
  fetchedAt = "2026-06-26T00:00:00.000Z",
): LiveBenchTrustedSnapshot => {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const durable = {
    sourceId: liveBenchSourceId(release, artifact),
    url: liveBenchSourceUrl(release, artifact),
    status: 200,
    fetchedAt,
    body,
    bodyHash,
  };
  const sourceRef = buildSnapshotSourceRef(durable);
  return {
    ok: true,
    integrity: "snapshot-envelope",
    reference: parseSnapshotSourceRef(sourceRef)!,
    snapshot: durable,
  };
};

const runs: LiveBenchImportInput["runs"] = {
  "gpt-5.6-sol-xhigh": {
    model: { id: "openai/gpt-5.6-sol", revision: null, quantization: null },
    runtime: { id: "openai-responses", version: null },
    workflowCondition: "reasoning_effort=xhigh",
    validUntil: null,
  },
  "gpt-5.6-terra-max": {
    model: { id: "openai/gpt-5.6-terra", revision: null, quantization: null },
    runtime: { id: "openai-responses", version: null },
    workflowCondition: "reasoning_effort=max",
    validUntil: null,
  },
  "qwen3.6-27b": {
    model: { id: "qwen/qwen3.6-27b", revision: null, quantization: null },
    runtime: { id: "alibaba-dashscope", version: null },
    workflowCondition: "thinking=enabled",
    validUntil: null,
  },
};

const input = (overrides: Partial<LiveBenchImportInput> = {}): LiveBenchImportInput => ({
  release,
  tableSnapshot: snapshot("table"),
  categoriesSnapshot: snapshot("categories"),
  runs,
  ...overrides,
});

test("LiveBench source descriptor and release artifacts are explicit", () => {
  assert.deepEqual(LIVEBENCH_SOURCE, {
    idPrefix: "livebench",
    owner: "LiveBench",
    origin: "https://livebench.ai",
    license: "NOASSERTION",
    sourceClass: "external",
  });
  assert.equal(liveBenchSourceId(release, "table"), "livebench-2026-06-25-table");
  assert.equal(liveBenchSourceUrl(release, "table"), "https://livebench.ai/table_2026_06_25.csv");
  assert.equal(liveBenchSourceUrl(release, "categories"), "https://livebench.ai/categories_2026_06_25.json");
  assert.throws(() => liveBenchSourceUrl("2026-02-30", "table"), /real calendar date/);
});

test("imports exact mapped rows as per-task observations without a universal score", () => {
  const result = importLiveBenchSnapshots(input());
  assert.equal(result.observations.length, 14);
  assert.equal(result.diagnostics.filter((item) => item.code === "unmapped-run").length, 1);
  assert.equal(result.diagnostics.filter((item) => item.code === "configured-run-missing").length, 1);
  assert.equal(result.acquisition.table.sourceUrl, liveBenchSourceUrl(release, "table"));
  assert.equal(result.acquisition.categories.sourceUrl, liveBenchSourceUrl(release, "categories"));

  const sol = result.observations.filter((item) => item.model.id === "openai/gpt-5.6-sol");
  assert.equal(sol.length, 7);
  assert.equal(sol.every((item) => item.measurements.length === 1), true);
  assert.equal(sol.find((item) => item.task?.taskId === "code_generation")?.measurements[0].key, "livebench.coding.score");
  assert.equal(sol.find((item) => item.task?.taskId === "python")?.measurements[0].key, "livebench.agentic-coding.score");
  assert.equal(sol.every((item) => item.task?.taskId !== null), true);
  assert.equal(sol.find((item) => item.task?.taskId === "code_generation")?.task?.family, "software-engineering");
  assert.equal(sol.find((item) => item.task?.taskId === "zebra_puzzle")?.task?.family, "reasoning");
  assert.equal(sol.find((item) => item.task?.taskId === "summarize")?.task?.family, "instruction-following");
  assert.equal(sol[0].execution?.workflow?.condition, "reasoning_effort=xhigh");
  assert.equal(sol[0].execution?.effectiveContextTokens, null);
  assert.equal(sol[0].evidence.length, 3);

  const catalog = compileCatalog(result.observations, { asOf: "2026-06-26T00:00:00.000Z" });
  assert.equal(catalog.models.length, 2);
  assert.equal(catalog.conflicts.length, 0);
});

test("exact mapping and observation order are deterministic and never fuzzy", () => {
  const first = importLiveBenchSnapshots(input());
  const reversed = Object.fromEntries(Object.entries(runs).reverse());
  assert.deepEqual(importLiveBenchSnapshots(input({ runs: reversed })), first);

  const fuzzy = importLiveBenchSnapshots(input({
    runs: { "GPT 5.6 Sol": runs["gpt-5.6-sol-xhigh"] },
  }));
  assert.equal(fuzzy.observations.length, 0);
  assert.equal(fuzzy.diagnostics.filter((item) => item.code === "unmapped-run").length, 3);
  assert.equal(fuzzy.diagnostics.some((item) => item.code === "configured-run-missing"), true);

  const inherited = Object.create({
    "gpt-5.6-sol-xhigh": runs["gpt-5.6-sol-xhigh"],
  });
  assert.equal(importLiveBenchSnapshots(input({ runs: inherited })).observations.length, 0);
});

test("unchanged source bytes produce identical observations across authenticated re-fetches", () => {
  const first = importLiveBenchSnapshots(input());
  const second = importLiveBenchSnapshots(input({
    tableSnapshot: snapshot("table", table, "2026-07-01T00:00:00.000Z"),
    categoriesSnapshot: snapshot("categories", categories, "2026-07-01T00:00:00.000Z"),
  }));
  assert.deepEqual(second.observations, first.observations);
  assert.notEqual(second.acquisition.table.sourceRef, first.acquisition.table.sourceRef);
  assert.throws(
    () => compileCatalog([...first.observations, ...second.observations], {
      asOf: "2026-07-02T00:00:00.000Z",
    }),
    /duplicate/i,
  );
});

test("unrelated artifact changes do not churn or double-weight stable task observations", () => {
  const first = importLiveBenchSnapshots(input());
  const unrelatedChange = table.replace('"unmapped,quoted",50,40,30,20,10,0,60', '"unmapped,quoted",51,40,30,20,10,0,60');
  const second = importLiveBenchSnapshots(input({ tableSnapshot: snapshot("table", unrelatedChange) }));
  assert.deepEqual(second.observations, first.observations);
  assert.notEqual(second.acquisition.table.bodySha256, first.acquisition.table.bodySha256);
  assert.throws(
    () => compileCatalog([...first.observations, ...second.observations], {
      asOf: "2026-07-02T00:00:00.000Z",
    }),
    /duplicate/i,
  );

  const oneScoreChanged = table.replace(",78.873,", ",79,");
  const third = importLiveBenchSnapshots(input({ tableSnapshot: snapshot("table", oneScoreChanged) }));
  const firstByTask = new Map(first.observations.map((item) => [`${item.model.id}:${item.task?.taskId}`, item]));
  for (const observation of third.observations) {
    const prior = firstByTask.get(`${observation.model.id}:${observation.task?.taskId}`)!;
    assert.equal(
      JSON.stringify(observation) === JSON.stringify(prior),
      observation.model.id !== "openai/gpt-5.6-sol" || observation.task?.taskId !== "code_generation",
    );
  }
});

test("requires matching full-envelope provenance for both official artifacts", () => {
  const wrongBodyHash = snapshot("table");
  wrongBodyHash.snapshot = { ...wrongBodyHash.snapshot, bodyHash: "0".repeat(64) };
  const wrongReference = snapshot("table");
  wrongReference.reference = { ...wrongReference.reference, sourceId: "forged" };
  const wrongFetchedAt = snapshot("categories");
  wrongFetchedAt.snapshot = { ...wrongFetchedAt.snapshot, fetchedAt: "2026-06-27T00:00:00.000Z" };
  for (const malformed of [
    input({ tableSnapshot: wrongBodyHash }),
    input({ tableSnapshot: wrongReference }),
    input({ categoriesSnapshot: { ...snapshot("categories"), integrity: "body-and-identity" as never } }),
    input({ categoriesSnapshot: wrongFetchedAt }),
  ]) {
    assert.throws(
      () => importLiveBenchSnapshots(malformed),
      (error: unknown) => error instanceof BearingError && error.code === "INVALID_SOURCE_SNAPSHOT",
    );
  }
});

test("supports BOM and quoted CSV while rejecting invalid UTF-8", () => {
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(table)]);
  const result = importLiveBenchSnapshots(input({ tableSnapshot: snapshot("table", withBom) }));
  assert.equal(result.observations.length, 14);
  assert.match(result.diagnostics.find((item) => item.code === "unmapped-run")?.message ?? "", /unmapped,quoted/);

  const invalidUtf8 = Buffer.from([0xff, 0xfe, 0xfd]);
  assert.throws(
    () => importLiveBenchSnapshots(input({ tableSnapshot: snapshot("table", invalidUtf8) })),
    /valid UTF-8/,
  );
  assert.throws(
    () => importLiveBenchSnapshots(input({ tableSnapshot: snapshot("table", `${table}\ud800`) })),
    /well-formed UTF-16|round-trip through the exact UTF-8 bytes/,
  );
});

test("fails closed on table width, duplicate ids/tasks, and invalid scores", () => {
  const cases = [
    table.replace("gpt-5.6-sol-xhigh,", "gpt-5.6-terra-max,"),
    table.replace("zebra_puzzle,code_generation", "zebra_puzzle,zebra_puzzle"),
    table.replace(",78.873,", ",not-a-number,"),
    table.replace(",78.873,", ",100.001,"),
    table.replace(",66.45\n", "\n"),
    table.replace(",66.45\n", ",66.45,extra\n"),
  ];
  for (const body of cases) {
    assert.throws(
      () => importLiveBenchSnapshots(input({ tableSnapshot: snapshot("table", body) })),
      (error: unknown) => error instanceof BearingError && error.code === "INVALID_SOURCE_SNAPSHOT",
    );
  }
});

test("fails closed on category schema drift, duplicate membership, and table mismatch", () => {
  const parsed = JSON.parse(categories) as Record<string, string[]>;
  const cases = [
    { ...parsed, Unknown: ["new_task"] },
    { ...parsed, Reasoning: [...parsed.Reasoning, "code_generation"] },
    { ...parsed, Reasoning: ["different_task"] },
    { ...parsed, IF: [] },
  ];
  for (const value of cases) {
    const body = JSON.stringify(value);
    assert.throws(
      () => importLiveBenchSnapshots(input({ categoriesSnapshot: snapshot("categories", body) })),
      (error: unknown) => error instanceof BearingError && error.code === "INVALID_SOURCE_SNAPSHOT",
    );
  }
  const duplicateKey = `{"Reasoning":["contradictory"],${categories.trim().slice(1)}`;
  assert.throws(
    () => importLiveBenchSnapshots(input({ categoriesSnapshot: snapshot("categories", duplicateKey) })),
    /must not duplicate an object key/,
  );
  for (const body of [
    `${"[".repeat(65)}0${"]".repeat(65)}`,
    `[${"0,".repeat(20_001)}0]`,
  ]) {
    assert.throws(
      () => importLiveBenchSnapshots(input({ categoriesSnapshot: snapshot("categories", body) })),
      (error: unknown) => error instanceof BearingError &&
        error.code === "INVALID_SOURCE_SNAPSHOT" &&
        /bounded|maximum JSON depth/.test(error.message),
    );
  }
});

test("enforces source, row, and column bounds before observation construction", () => {
  const oversized = "x".repeat(8 * 1024 * 1024 + 1);
  assert.throws(
    () => importLiveBenchSnapshots(input({ tableSnapshot: snapshot("table", oversized) })),
    /exceeds/,
  );

  const tooManyRows = `${table.split("\n", 1)[0]}\n${Array.from(
    { length: 10_001 },
    (_, index) => `model-${index},1,1,1,1,1,1,1`,
  ).join("\n")}\n`;
  assert.throws(
    () => importLiveBenchSnapshots(input({ tableSnapshot: snapshot("table", tooManyRows) })),
    /more than 10000 rows/,
  );

  const tooManyColumns = `model,${Array.from({ length: 512 }, (_, index) => `task-${index}`).join(",")}\n`;
  assert.throws(
    () => importLiveBenchSnapshots(input({ tableSnapshot: snapshot("table", tooManyColumns) })),
    /more than 512 columns/,
  );

  const boundedHeader = ["model", ...Array.from({ length: 500 }, (_, index) => `task-${index}`)].join(",");
  const boundedRow = ["row", ...Array.from({ length: 500 }, () => "1")].join(",");
  const tooManyCells = `${boundedHeader}\n${Array.from({ length: 200 }, (_, index) => boundedRow.replace("row", `row-${index}`)).join("\n")}\n`;
  assert.throws(
    () => importLiveBenchSnapshots(input({ tableSnapshot: snapshot("table", tooManyCells) })),
    /more than 100000 bounded CSV cells/,
  );

  const tooManyTasks = Array.from({ length: 512 }, (_, index) => `task-${index}`);
  const categoryValue = {
    ...JSON.parse(categories),
    Reasoning: tooManyTasks,
  };
  assert.throws(
    () => importLiveBenchSnapshots(input({
      categoriesSnapshot: snapshot("categories", JSON.stringify(categoryValue)),
    })),
    /bounded task array/,
  );
});

test("caps aggregate row-by-task expansion before allocating observations", () => {
  const bulkTasks = Array.from({ length: 500 }, (_, index) => `reasoning-${index}`);
  const categoryValue = {
    Reasoning: bulkTasks,
    Coding: ["coding"],
    "Agentic Coding": ["agentic"],
    Mathematics: ["mathematics"],
    "Data Analysis": ["data-analysis"],
    Language: ["language"],
    IF: ["instruction-following"],
  };
  const tasks = Object.values(categoryValue).flat();
  const modelIds = Array.from({ length: 100 }, (_, index) => `mapped-${index}`);
  const bulkTable = [
    ["model", ...tasks].join(","),
    ...modelIds.map((modelId) => [modelId, ...tasks.map(() => "1")].join(",")),
  ].join("\n");
  const mapping = Object.fromEntries(modelIds.map((modelId) => [modelId, runs["gpt-5.6-sol-xhigh"]]));
  assert.throws(
    () => importLiveBenchSnapshots(input({
      tableSnapshot: snapshot("table", bulkTable),
      categoriesSnapshot: snapshot("categories", JSON.stringify(categoryValue)),
      runs: mapping,
    })),
    /expand beyond 50000 task observations/,
  );
});

test("invalid reviewed mappings remain typed source failures", () => {
  const invalid = {
    ...runs,
    "gpt-5.6-sol-xhigh": {
      ...runs["gpt-5.6-sol-xhigh"],
      workflowCondition: "",
    },
  };
  assert.throws(
    () => importLiveBenchSnapshots(input({ runs: invalid })),
    (error: unknown) => error instanceof BearingError && error.path.includes("workflowCondition"),
  );
});
