import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { createFilesystemSnapshotStore } from "@kontourai/forage";
import { buildSnapshotSourceRef, fetchSource, parseSnapshotSourceRef } from "@kontourai/forage/fetch";

import {
  discoverLiveBenchBundle,
  isDefaultApprovedSourceIdentity,
  parseApprovedSourceManifest,
  resolveLiveBenchDiscovery,
} from "../dist/src/index.js";

const root = path.resolve(process.cwd());
const proofRoot = path.join(root, ".kontourai", "bearing", "trusted-source-proof", "livebench");
const store = createFilesystemSnapshotStore({ root: path.join(proofRoot, "snapshots") });
const manifest = parseApprovedSourceManifest(await readFile(path.join(root, "sources", "approved-sources.v1.json")));
const source = manifest.sources.find((candidate) => candidate.id === "livebench");
if (!source) throw new Error("Packaged manifest does not approve LiveBench");
if (!isDefaultApprovedSourceIdentity(source)) {
  throw new Error("Packaged manifest does not exactly match the reviewed LiveBench source identity");
}

const acquire = async ({ sourceId, url, maxBytes, mediaType }) => {
  const result = await fetchSource({
    id: sourceId,
    url,
    timeoutMs: 30_000,
    retries: 2,
    respectRobots: true,
    egress: { guarded: true },
  }, { store });
  if (!result.snapshot) {
    throw new Error(`Guarded acquisition failed for ${sourceId}: ${result.error?.kind ?? "no-snapshot"}: ${result.error?.message ?? "unknown error"}`);
  }
  const bytes = typeof result.snapshot.body === "string"
    ? Buffer.byteLength(result.snapshot.body, "utf8")
    : result.snapshot.body.byteLength;
  if (bytes > maxBytes) throw new Error(`${sourceId} exceeds manifest maxBytes ${maxBytes}`);
  const contentType = result.snapshot.headers?.["content-type"]?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== mediaType) {
    throw new Error(`${sourceId} returned ${contentType ?? "no content type"}; expected ${mediaType}`);
  }
  if (!result.snapshot.notModified) await store.put(result.snapshot);
  const sourceRef = buildSnapshotSourceRef(result.snapshot);
  return {
    resolution: {
      ok: true,
      integrity: "snapshot-envelope",
      reference: parseSnapshotSourceRef(sourceRef),
      snapshot: result.snapshot,
    },
    evidence: { sourceId, url, bodySha256: result.snapshot.bodyHash, bytes, sourceRef },
  };
};

const index = await acquire(source.resolver.entrypoint);
const bundleLocator = discoverLiveBenchBundle({
  manifest,
  sourceId: source.id,
  indexSnapshot: index.resolution,
});
const bundle = await acquire(bundleLocator.bundle);
const proposal = resolveLiveBenchDiscovery({
  manifest,
  sourceId: source.id,
  indexSnapshot: index.resolution,
  bundleSnapshot: bundle.resolution,
});
const artifacts = [];
for (const locator of proposal.artifacts) {
  artifacts.push((await acquire(locator)).evidence);
}

const report = {
  schemaVersion: "bearing.trusted-source-proof/v1",
  sourceId: source.id,
  manifestDigest: manifest.digest,
  proposal,
  acquisitions: { index: index.evidence, bundle: bundle.evidence, artifacts },
};
await mkdir(proofRoot, { recursive: true });
await writeFile(path.join(proofRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  sourceId: report.sourceId,
  manifestDigest: report.manifestDigest,
  proposalId: proposal.id,
  currentRevision: proposal.currentRevision,
  releaseCount: proposal.revisions.length,
  bundleUrl: proposal.bundle.url,
  artifacts: artifacts.map(({ sourceId, url, bodySha256, bytes }) => ({ sourceId, url, bodySha256, bytes })),
  report: path.join(proofRoot, "report.json"),
})}\n`);
