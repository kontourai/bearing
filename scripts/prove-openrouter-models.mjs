import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { createFilesystemSnapshotStore } from "@kontourai/forage";
import {
  buildSnapshotSourceRef,
  fetchSource,
  parseSnapshotSourceRef,
  resolveSnapshotSourceRef,
} from "@kontourai/forage/fetch";

import {
  importOpenRouterModelsSnapshot,
  isDefaultApprovedSourceIdentity,
  parseApprovedSourceManifest,
} from "../dist/src/index.js";

const root = path.resolve(process.cwd());
const proofRoot = path.join(root, ".kontourai", "bearing", "trusted-source-proof", "openrouter-models");
const store = createFilesystemSnapshotStore({ root: path.join(proofRoot, "snapshots") });
const manifest = parseApprovedSourceManifest(await readFile(path.join(root, "sources", "approved-sources.v1.json")));
const source = manifest.sources.find((candidate) => candidate.id === "openrouter-models");
if (!source) throw new Error("Packaged manifest does not approve OpenRouter models");
if (!isDefaultApprovedSourceIdentity(source)) {
  throw new Error("Packaged manifest does not exactly match the reviewed OpenRouter source identity");
}

const result = await fetchSource({
  id: source.resolver.entrypoint.sourceId,
  url: source.resolver.entrypoint.url,
  timeoutMs: 30_000,
  retries: 2,
  respectRobots: true,
  egress: { guarded: true },
}, { store, maxResponseBytes: source.resolver.entrypoint.maxBytes });
if (!result.snapshot) {
  throw new Error(`Guarded acquisition failed: ${result.error?.kind ?? "no-snapshot"}: ${result.error?.message ?? "unknown error"}`);
}
const bytes = typeof result.snapshot.body === "string"
  ? Buffer.byteLength(result.snapshot.body, "utf8")
  : result.snapshot.body.byteLength;
if (bytes > source.resolver.entrypoint.maxBytes || bytes > source.resolver.maxBytes) {
  throw new Error(`OpenRouter response exceeds approved maxBytes: ${bytes}`);
}
if (!result.snapshot.notModified) await store.put(result.snapshot);
const sourceRef = buildSnapshotSourceRef(result.snapshot);
const snapshot = {
  ok: true,
  integrity: "snapshot-envelope",
  reference: parseSnapshotSourceRef(sourceRef),
  snapshot: result.snapshot,
};

const reviewedIds = [
  "openai/gpt-5.6-luna-pro",
  "openai/gpt-5.6-luna",
  "openai/gpt-5.6-terra-pro",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-sol-pro",
  "openai/gpt-5.6-sol",
];
const models = Object.fromEntries(reviewedIds.map((id) => [id, {
  model: { id, revision: null, quantization: null },
  validUntil: null,
}]));
const imported = importOpenRouterModelsSnapshot({ manifest, sourceId: source.id, snapshot, models });
const missing = imported.diagnostics.filter((item) => item.code === "configured-model-missing");
if (missing.length > 0) throw new Error(`Reviewed OpenRouter rows are missing: ${missing.map((item) => item.path).join(", ")}`);
const replay = await resolveSnapshotSourceRef(store, sourceRef);
if (!replay.ok) throw new Error(`Exact offline replay failed: ${replay.error.kind}: ${replay.error.message}`);
const replayed = importOpenRouterModelsSnapshot({ manifest, sourceId: source.id, snapshot: replay, models });
if (JSON.stringify(replayed.observations) !== JSON.stringify(imported.observations)) {
  throw new Error("Exact offline replay changed normalized observations");
}

const report = {
  schemaVersion: "bearing.trusted-source-proof/v1",
  sourceId: source.id,
  manifestDigest: manifest.digest,
  acquisition: imported.acquisition,
  reviewedMappings: reviewedIds,
  observations: imported.observations,
  diagnostics: imported.diagnostics,
  replay: { sourceRef, verified: true },
};
await mkdir(proofRoot, { recursive: true });
await writeFile(path.join(proofRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  sourceId: source.id,
  manifestDigest: manifest.digest,
  revision: imported.acquisition.revision,
  bytes,
  rowCount: imported.acquisition.rowCount,
  mappedRows: reviewedIds.length,
  observationCount: imported.observations.length,
  unmappedRows: imported.diagnostics.filter((item) => item.code === "unmapped-model").length,
  replayVerified: true,
  report: path.join(proofRoot, "report.json"),
})}\n`);
