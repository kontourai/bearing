import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  AIDER_POLYGLOT_SOURCE,
  BearingError,
  aiderPolyglotSourceUrl,
  compileCatalog,
  importAiderPolyglotSnapshot,
  type AiderPolyglotImportInput,
} from "../src/index.js";

const fixture = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "tests",
    "fixtures",
    "aider-polyglot.yml",
  ),
  "utf8",
);

const sourceCommit = "5dc9490bb35f9729ef2c95d00a19ccd30c26339c";

const snapshot = (
  body: string | Uint8Array = fixture,
  fetchedAt = "2026-07-18T23:00:00.000Z",
  commit = sourceCommit,
) => {
  const bodySha256 = createHash("sha256").update(body).digest("hex");
  const snapshotSha256 = createHash("sha256")
    .update(`envelope:${bodySha256}:${fetchedAt}:${commit}`)
    .digest("hex");
  const params = new URLSearchParams({
    url: aiderPolyglotSourceUrl(commit),
    sha256: bodySha256,
    fetchedAt,
    snapshotSha256,
  });
  return {
    body,
    bodySha256,
    sourceRef: `forage-snapshot:${AIDER_POLYGLOT_SOURCE.id}?${params}`,
    integrity: "snapshot-envelope" as const,
    fetchedAt,
    sourceCommit: commit,
  };
};

const runs: AiderPolyglotImportInput["runs"] = {
  "2025-05-08-03-20-24--qwen3-32b-default": {
    model: { id: "qwen/qwen3-32b", revision: null, quantization: null },
    runtime: { id: "openrouter", version: null },
    validUntil: "2026-05-08T00:00:00.000Z",
  },
  "2025-05-09-17-02-02--qwen3-235b-a22b.unthink_16k_diff": {
    model: { id: "qwen/qwen3-235b-a22b", revision: null, quantization: null },
    runtime: { id: "alibaba-api", version: null },
    validUntil: "2026-05-09T00:00:00.000Z",
  },
};

test("Aider source descriptor names the official licensed structured artifact", () => {
  assert.deepEqual(AIDER_POLYGLOT_SOURCE, {
    id: "aider-polyglot-leaderboard",
    owner: "Aider-AI",
    repository: "aider",
    path: "aider/website/_data/polyglot_leaderboard.yml",
    license: "Apache-2.0",
    sourceClass: "external",
  });
});

test("imports explicitly mapped Aider runs as scoped external observations", () => {
  const result = importAiderPolyglotSnapshot({ snapshot: snapshot(), runs });
  assert.equal(result.observations.length, 2);
  assert.equal(result.diagnostics.filter((item) => item.code === "unmapped-run").length, 3);
  assert.equal(result.acquisition.sourceUrl, aiderPolyglotSourceUrl(sourceCommit));

  const small = result.observations.find((item) => item.model.id === "qwen/qwen3-32b")!;
  assert.equal(small.execution?.runtime.id, "openrouter");
  assert.equal(small.execution?.workflow?.condition, "edit_format=diff");
  assert.equal(small.task?.suite, "aider.polyglot");
  assert.equal(small.usage?.inputTokens, 317591);
  assert.equal(small.usage?.outputTokens, 120418);
  assert.equal(small.usage?.totalTokens, 438009);
  assert.equal(small.usage?.wallTimeMs, 83745000);
  assert.equal(small.evidence[0].kind, "forage-snapshot");
  assert.match(small.evidence[0].uri ?? "", /^urn:forage:snapshot:sha256:[a-f0-9]{64}$/);
  assert.match(small.evidence[1].uri ?? "", /^urn:aider:polyglot:.*:sha256:[a-f0-9]{64}$/);
  assert.equal(
    small.measurements.find((item) => item.key === "aider.polyglot.pass_rate_2")?.value,
    40,
  );

  const catalog = compileCatalog(result.observations, { asOf: snapshot().fetchedAt });
  assert.equal(catalog.models.length, 2);
});

test("exact run mappings are deterministic and never fuzzy-match model labels", () => {
  const first = importAiderPolyglotSnapshot({ snapshot: snapshot(), runs });
  const reversed = Object.fromEntries(Object.entries(runs).reverse());
  const second = importAiderPolyglotSnapshot({ snapshot: snapshot(), runs: reversed });
  assert.deepEqual(second, first);

  const fuzzy = importAiderPolyglotSnapshot({
    snapshot: snapshot(),
    runs: { "Qwen3 32B": runs["2025-05-08-03-20-24--qwen3-32b-default"] },
  });
  assert.equal(fuzzy.observations.length, 0);
  assert.equal(fuzzy.diagnostics.some((item) => item.code === "configured-run-missing"), true);

  const inheritedRuns = Object.create({
    "2025-05-08-03-20-24--qwen3-32b-default": runs["2025-05-08-03-20-24--qwen3-32b-default"],
  });
  const inherited = importAiderPolyglotSnapshot({ snapshot: snapshot(), runs: inheritedRuns });
  assert.equal(inherited.observations.length, 0);
});

test("supports real heterogeneous rows without inventing missing cost", () => {
  const heterogeneousRuns: AiderPolyglotImportInput["runs"] = {
    "2025-01-28-16-00-03--qwen-max-2025-01-25-polyglot-diff": {
      model: { id: "qwen/qwen-max-2025-01-25", revision: null, quantization: null },
      runtime: { id: "alibaba-api", version: null },
      validUntil: null,
    },
    "2025-04-12-04-55-50--gemini-25-pro-diff-fenced": {
      model: { id: "google/gemini-2.5-pro-preview-03-25", revision: null, quantization: null },
      runtime: { id: "google-api", version: null },
      validUntil: null,
    },
  };
  const result = importAiderPolyglotSnapshot({ snapshot: snapshot(), runs: heterogeneousRuns });
  assert.equal(result.observations.length, 2);
  const qwen = result.observations.find((item) => item.model.id === "qwen/qwen-max-2025-01-25")!;
  assert.equal(qwen.measurements.some((item) => item.key === "aider.polyglot.total_cost"), false);
  assert.equal(qwen.uncertainty.gaps.includes("benchmark row does not report total cost"), true);
  const gemini = result.observations.find((item) => item.model.id.startsWith("google/"))!;
  assert.equal(gemini.execution?.workflow?.version, "0282574");
});

test("unchanged run observations remain identical across authenticated re-fetches", () => {
  const first = importAiderPolyglotSnapshot({ snapshot: snapshot(), runs });
  const mirrorCommit = "cb6a152b2075287d4559a6b6ab96066a702f9694";
  const second = importAiderPolyglotSnapshot({
    snapshot: snapshot(fixture, "2026-07-19T23:00:00.000Z", mirrorCommit),
    runs,
  });
  assert.deepEqual(second.observations, first.observations);
  assert.notEqual(second.acquisition.sourceRef, first.acquisition.sourceRef);
  assert.equal(second.acquisition.sourceUrl, aiderPolyglotSourceUrl(mirrorCommit));
  assert.throws(
    () => compileCatalog([...first.observations, ...second.observations], {
      asOf: "2026-07-20T00:00:00.000Z",
    }),
    /duplicate/i,
  );
});

test("rejects unauthenticated, aliased, duplicate, and mapped schema-drift input", () => {
  assert.throws(
    () => importAiderPolyglotSnapshot({ snapshot: { ...snapshot(), bodySha256: "0".repeat(64) }, runs }),
    (error: unknown) => error instanceof BearingError && error.code === "INVALID_SOURCE_SNAPSHOT",
  );
  assert.throws(
    () => importAiderPolyglotSnapshot({ snapshot: { ...snapshot(), sourceRef: "forage-snapshot:forged" }, runs }),
    /official immutable source URL|full snapshot envelope/,
  );
  const aliased = "- &run\n  dirname: x\n  model: x\n- *run\n";
  assert.throws(() => importAiderPolyglotSnapshot({ snapshot: snapshot(aliased), runs: {} }), /aliases/);

  const duplicate = `${fixture}\n${fixture.split("\n\n", 1)[0]}\n`;
  assert.throws(() => importAiderPolyglotSnapshot({ snapshot: snapshot(duplicate), runs }), /duplicates row/);

  const drifted = fixture.replace("  pass_rate_2: 40.0\n", "");
  assert.throws(
    () => importAiderPolyglotSnapshot({ snapshot: snapshot(drifted), runs }),
    (error: unknown) => error instanceof BearingError && error.path.endsWith(".pass_rate_2"),
  );

  const impossible = fixture.replace("  pass_rate_2: 40.0\n", "  pass_rate_2: 140.0\n");
  assert.throws(() => importAiderPolyglotSnapshot({ snapshot: snapshot(impossible), runs }), /between 0 and 100/);

  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(fixture)]);
  assert.equal(importAiderPolyglotSnapshot({ snapshot: snapshot(bytes), runs }).observations.length, 2);
});
