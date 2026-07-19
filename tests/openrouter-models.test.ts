import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildSnapshotSourceRef, parseSnapshotSourceRef } from "@kontourai/forage/fetch";
import {
  BearingError,
  importOpenRouterModelsSnapshot,
  parseApprovedSourceManifest,
  type OpenRouterModelsImportInput,
} from "../src/index.js";
import { sha256 } from "../src/canonical.js";

const manifestBody = readFileSync(path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "sources",
  "approved-sources.v1.json",
), "utf8");
const manifest = parseApprovedSourceManifest(manifestBody);
const sourceId = "openrouter-models";

const modelRow = (
  id: string,
  benchmarks: Record<string, number | null> | null = null,
  designArena: unknown[] = [],
) => ({
  id,
  canonical_slug: id,
  hugging_face_id: null,
  name: id,
  created: 1_752_796_800,
  description: "Reviewed test row",
  context_length: 1_050_000,
  architecture: {
    modality: "text+image->text",
    input_modalities: ["text", "image", "file"],
    output_modalities: ["text"],
    tokenizer: "GPT",
    instruct_type: null,
  },
  pricing: { prompt: "0.00000175", completion: "0.000014", input_cache_read: "0.000000175" },
  top_provider: { context_length: 1_050_000, max_completion_tokens: 128_000, is_moderated: true },
  per_request_limits: null,
  supported_parameters: ["tools", "structured_outputs", "reasoning"],
  default_parameters: {},
  supported_voices: null,
  knowledge_cutoff: "2024-09-30",
  expiration_date: null,
  links: { details: `/api/v1/models/${id}/endpoints` },
  benchmarks: { design_arena: designArena, artificial_analysis: benchmarks },
  reasoning: {
    mandatory: false,
    default_enabled: true,
    supported_efforts: ["max", "xhigh", "high", "medium", "low", "none"],
    default_effort: "medium",
  },
});

const body = JSON.stringify({
  data: [
    modelRow(
      "openai/gpt-5.6-sol",
      { intelligence_index: 58.9, coding_index: 77.4, agentic_index: 54 },
      [{ arena: "agents", category: "fullstack", elo: 1302, win_rate: 60.6, rank: 2 }],
    ),
    modelRow("unmapped/example"),
  ],
  total_count: 2,
  links: { next: null },
});

const snapshot = (snapshotBody = body) => {
  const durable = {
    sourceId,
    url: "https://openrouter.ai/api/v1/models",
    status: 200,
    fetchedAt: "2026-07-19T00:00:00.000Z",
    body: snapshotBody,
    bodyHash: createHash("sha256").update(snapshotBody).digest("hex"),
    headers: { "content-type": "application/json; charset=utf-8" },
  };
  const sourceRef = buildSnapshotSourceRef(durable);
  return {
    ok: true as const,
    integrity: "snapshot-envelope" as const,
    reference: parseSnapshotSourceRef(sourceRef)!,
    snapshot: durable,
  };
};

const models: OpenRouterModelsImportInput["models"] = {
  "openai/gpt-5.6-sol": {
    model: { id: "openai/gpt-5.6-sol", revision: null, quantization: null },
    validUntil: null,
  },
};

const importSnapshot = (overrides: Partial<OpenRouterModelsImportInput> = {}) => importOpenRouterModelsSnapshot({
  manifest,
  sourceId,
  snapshot: snapshot(),
  models,
  ...overrides,
});

test("imports exact OpenRouter runtime facts and attributed benchmark samples", () => {
  const result = importSnapshot();
  assert.equal(result.observations.length, 21);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, "unmapped-model");
  assert.equal(result.acquisition.manifestDigest, manifest.digest);
  assert.equal(result.acquisition.revision, result.acquisition.bodySha256);

  const facts = result.observations.filter((item) => item.task === null);
  const fact = (key: string) => facts.find((item) => item.measurements[0]?.key === key)?.measurements[0];
  assert.equal(facts.length, 17);
  assert.equal(facts[0].execution?.kind, "partial");
  assert.equal(facts[0].execution?.runtime.id, "openrouter");
  assert.equal(facts[0].execution?.adapter, null);
  assert.equal(facts[0].execution?.toolSurface, null);
  assert.equal(fact("openrouter.model.context.max_tokens")?.value, 1_050_000);
  assert.equal(fact("openrouter.top_provider.context.max_tokens")?.value, 1_050_000);
  assert.equal(fact("openrouter.reasoning.effort.xhigh")?.value, true);
  assert.equal(facts[0].freshness.validUntil, "2026-07-20T00:00:00.000Z");

  const agentic = result.observations.find((item) => item.task?.taskId === "agentic")!;
  assert.equal(agentic.measurements[0].value, 54);
  assert.equal(agentic.execution, null);
  assert.equal(agentic.uncertainty.level, "high");
  assert.equal(agentic.evidence.some((item) => item.id.startsWith("openrouter-attributed-artificial-analysis:")), true);
  assert.equal(agentic.evidence.some((item) => item.uri?.startsWith("urn:bearing:openrouter-model-field:") === true), true);
  assert.deepEqual(
    agentic.evidence.find((item) => item.kind === "benchmark-attribution"),
    {
      id: "artificial-analysis-attribution",
      kind: "benchmark-attribution",
      uri: "https://artificialanalysis.ai/",
      digest: null,
      observedAt: "2026-07-19T00:00:00.000Z",
    },
  );
  assert.equal(agentic.evidence.some((item) => item.uri?.includes("artificialanalysis.ai/:sha256:") === true), false);

  const design = result.observations.find((item) => item.task?.suite === "design-arena")!;
  assert.equal(design.task?.taskId, "agents/fullstack");
  assert.equal(design.measurements.find((item) => item.key === "design-arena.elo")?.value, 1302);
  assert.equal(design.execution, null);
});

test("mapping and output are deterministic and exact rather than fuzzy", () => {
  const first = importSnapshot();
  const second = importSnapshot({ models: Object.fromEntries(Object.entries(models).reverse()) });
  assert.deepEqual(second, first);

  const changedRow = JSON.parse(body);
  changedRow.data[0].pricing.prompt = "0.000002";
  const changed = importSnapshot({ snapshot: snapshot(JSON.stringify(changedRow)) });
  const stable = (result: ReturnType<typeof importSnapshot>) => result.observations.filter((item) =>
    item.task !== null || item.measurements[0]?.key !== "openrouter.price.prompt_usd_per_token");
  assert.deepEqual(stable(changed), stable(first));
  assert.notDeepEqual(changed.observations, first.observations);
  assert.notEqual(changed.acquisition.revision, first.acquisition.revision);

  const fuzzy = importSnapshot({
    models: {
      "GPT 5.6 Sol": models["openai/gpt-5.6-sol"],
    },
  });
  assert.equal(fuzzy.observations.length, 0);
  assert.equal(fuzzy.diagnostics.some((item) => item.code === "configured-model-missing"), true);
});

test("fails closed on unparsed policy, snapshot tampering, duplicate keys, and schema drift", () => {
  assert.throws(
    () => importSnapshot({ manifest: structuredClone(manifest) }),
    (error: unknown) => error instanceof BearingError && error.code === "INVALID_SOURCE_SNAPSHOT",
  );

  const tampered = snapshot();
  tampered.reference = { ...tampered.reference, bodyHash: "0".repeat(64) };
  assert.throws(() => importSnapshot({ snapshot: tampered }), /recomputed snapshot envelope/);

  const duplicate = body.replace('"total_count":2', '"total_count":2,"total_count":2');
  assert.throws(() => importSnapshot({ snapshot: snapshot(duplicate) }), /duplicate an object key/);

  const drifted = JSON.stringify({ ...JSON.parse(body), unexpected: true });
  assert.throws(() => importSnapshot({ snapshot: snapshot(drifted) }), /must contain exactly/);

  const unsafe = body.replace('"default_parameters":{}', '"default_parameters":{"__proto__":{"polluted":true}}');
  assert.throws(() => importSnapshot({ snapshot: snapshot(unsafe) }), /forbidden key __proto__/);

  const unsupportedEffort = body.replace('"max","xhigh"', '"unreviewed","xhigh"');
  assert.throws(() => importSnapshot({ snapshot: snapshot(unsupportedEffort) }), /unsupported efforts/);

  const underflow = body.replace('"prompt":"0.00000175"', '"prompt":"1e-9999"');
  assert.throws(() => importSnapshot({ snapshot: snapshot(underflow) }), /fixed-point|decimal string/);

  const ignoredFieldAmplification = JSON.parse(body);
  ignoredFieldAmplification.data[0].default_parameters.temperature = Array.from({ length: 1_000 }, () => 0);
  assert.throws(
    () => importSnapshot({ snapshot: snapshot(JSON.stringify(ignoredFieldAmplification)) }),
    /null or a finite number/,
  );

  const structuralAmplification = JSON.parse(body);
  structuralAmplification.data[0].default_parameters.temperature = Array.from({ length: 110_000 }, () => 0);
  assert.throws(
    () => importSnapshot({ snapshot: snapshot(JSON.stringify(structuralAmplification)) }),
    /bounded JSON structure size/,
  );

  assert.throws(
    () => importSnapshot({ snapshot: snapshot(JSON.stringify({ data: [], total_count: 0, links: { next: null } })) }),
    /between 1 and 5000 model rows/,
  );

  const oversizedId = modelRow(`provider/${"x".repeat(504)}`);
  assert.throws(
    () => importSnapshot({ snapshot: snapshot(JSON.stringify({ data: [oversizedId], total_count: 1, links: { next: null } })) }),
    /identity of at most 512 characters/,
  );

  const invalidUnicodeId = modelRow("provider/\ud800");
  assert.throws(
    () => importSnapshot({ snapshot: snapshot(JSON.stringify({ data: [invalidUnicodeId], total_count: 1, links: { next: null } })) }),
    /URI-encodable Unicode text/,
  );

  const oversizedCategory = modelRow("openai/gpt-5.6-sol", null, [{
    arena: "agents", category: "x".repeat(257), elo: 1_000, win_rate: 50, rank: 1,
  }]);
  assert.throws(
    () => importSnapshot({ snapshot: snapshot(JSON.stringify({ data: [oversizedCategory], total_count: 1, links: { next: null } })) }),
    /identity of at most 256 characters/,
  );

  assert.throws(
    () => importSnapshot({ models: {
      "openai/gpt-5.6-sol": {
        model: { id: "x".repeat(1_025), revision: null, quantization: null },
        validUntil: null,
      },
    } }),
    /must be at most 1024 UTF-8 bytes/,
  );
});

test("independently rejects a custom-registry source that launders the OpenRouter adapter identity", () => {
  const attackerDocument = JSON.parse(manifestBody);
  const attackerSource = attackerDocument.sources.find((item: { id: string }) => item.id === sourceId);
  attackerDocument.sources = [attackerSource];
  attackerSource.canonicalOrigin = "https://attacker.example/";
  attackerSource.resolver.entrypoint.url = "https://attacker.example/models";

  const normalized = structuredClone(manifest.sources.find((item) => item.id === sourceId)!) as unknown as {
    canonicalOrigin: string;
    resolver: { entrypoint: { url: string } };
  };
  normalized.canonicalOrigin = "https://attacker.example";
  normalized.resolver.entrypoint.url = "https://attacker.example/models";
  const attackerManifest = parseApprovedSourceManifest(JSON.stringify(attackerDocument), {
    sources: [{ id: sourceId, digest: sha256(normalized) }],
  });
  assert.throws(
    () => importSnapshot({ manifest: attackerManifest }),
    /approved official OpenRouter source identity/,
  );
});

test("independently rejects custom-registry provenance laundering on the official OpenRouter endpoint", () => {
  const attackerDocument = JSON.parse(manifestBody);
  const attackerSource = attackerDocument.sources.find((item: { id: string }) => item.id === sourceId);
  attackerDocument.sources = [attackerSource];
  attackerSource.trustRationale = "Attacker-supplied provenance";
  const normalized = structuredClone(manifest.sources.find((item) => item.id === sourceId)!) as unknown as {
    trustRationale: string;
  };
  normalized.trustRationale = "Attacker-supplied provenance";
  const attackerManifest = parseApprovedSourceManifest(JSON.stringify(attackerDocument), {
    sources: [{ id: sourceId, digest: sha256(normalized) }],
  });
  assert.throws(
    () => importSnapshot({ manifest: attackerManifest }),
    /approved official OpenRouter source identity/,
  );
});

test("accepts explicitly partial attributed indexes without inventing missing samples", () => {
  const partial = JSON.parse(body);
  partial.data[0].benchmarks.artificial_analysis = { intelligence_index: 58.9 };
  const result = importSnapshot({ snapshot: snapshot(JSON.stringify(partial)) });
  const samples = result.observations.filter((item) => item.task?.suite === "artificial-analysis");
  assert.deepEqual(samples.map((item) => item.task?.taskId), ["intelligence"]);
});

test("rejects mapped-row observation amplification before constructing observations", () => {
  const designSamples = Array.from({ length: 4 }, (_, index) => ({
    arena: "agents",
    category: `category-${index}`,
    elo: 1_000 + index,
    win_rate: 50,
    rank: index + 1,
  }));
  const rows = Array.from({ length: 500 }, (_, index) => modelRow(`mapped/model-${index}`, null, designSamples));
  const amplifiedBody = JSON.stringify({ data: rows, total_count: rows.length, links: { next: null } });
  const amplifiedModels = Object.fromEntries(rows.map((row) => [row.id, {
    model: { id: row.id, revision: null, quantization: null },
    validUntil: null,
  }]));
  assert.throws(
    () => importSnapshot({ snapshot: snapshot(amplifiedBody), models: amplifiedModels }),
    /mapped rows must expand to at most 10000 observations/,
  );
});

test("rejects aggregate normalized-byte amplification below the observation-count ceiling", () => {
  const designSamples = Array.from({ length: 4 }, (_, index) => ({
    arena: "agents",
    category: `category-${index}`,
    elo: 1_000 + index,
    win_rate: 50,
    rank: index + 1,
  }));
  const rows = Array.from({ length: 400 }, (_, index) => modelRow(`mapped/model-${index}`, null, designSamples));
  const amplifiedBody = JSON.stringify({ data: rows, total_count: rows.length, links: { next: null } });
  const amplifiedModels = Object.fromEntries(rows.map((row) => [row.id, {
    model: { id: row.id, revision: null, quantization: null },
    validUntil: null,
  }]));
  assert.throws(
    () => importSnapshot({ snapshot: snapshot(amplifiedBody), models: amplifiedModels }),
    /estimated output bytes/,
  );
});
