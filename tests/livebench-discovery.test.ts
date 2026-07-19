import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildSnapshotSourceRef, parseSnapshotSourceRef } from "@kontourai/forage/fetch";
import {
  BearingError,
  discoverLiveBenchBundle,
  liveBenchBundleSourceId,
  parseApprovedSourceManifest,
  resolveLiveBenchDiscovery,
  type TrustedDiscoverySnapshot,
} from "../src/index.js";

const manifestSource = readFileSync(path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "sources",
  "approved-sources.v1.json",
), "utf8");
const manifest = parseApprovedSourceManifest(manifestSource);
const indexBody = '<!doctype html><script src="https://example.test/analytics.js"></script><script defer src="./static/js/main.abcdef12.js"></script>';
const bundleUrl = "https://livebench.ai/static/js/main.abcdef12.js";
const bundleBody = 'const releases=["2024-06-24","2025-05-30","2026-06-25"];const unrelated="2026-07-01";';

const snapshot = (
  sourceId: string,
  url: string,
  body: string | Uint8Array,
  options: { mediaType?: string; fetchedAt?: string } = {},
): TrustedDiscoverySnapshot => {
  const mediaType = options.mediaType ?? (sourceId === "livebench-index" ? "text/html" : "application/javascript");
  const durable = {
    sourceId,
    url,
    status: 200,
    fetchedAt: options.fetchedAt ?? "2026-07-19T00:00:00.000Z",
    body,
    bodyHash: createHash("sha256").update(body).digest("hex"),
    headers: { "content-type": `${mediaType}; charset=utf-8` },
  };
  const sourceRef = buildSnapshotSourceRef(durable);
  return {
    ok: true,
    integrity: "snapshot-envelope",
    reference: parseSnapshotSourceRef(sourceRef)!,
    snapshot: durable,
  };
};

const indexSnapshot = (body = indexBody) => snapshot("livebench-index", "https://livebench.ai/", body);
const bundleSnapshot = (body = bundleBody, url = bundleUrl) => snapshot(liveBenchBundleSourceId(url), url, body);

test("discovers the same-origin hashed main bundle from the approved official entrypoint", () => {
  const discovery = discoverLiveBenchBundle({ manifest, sourceId: "livebench", indexSnapshot: indexSnapshot() });
  assert.equal(discovery.bundle.url, bundleUrl);
  assert.equal(discovery.bundle.sourceId, liveBenchBundleSourceId(bundleUrl));
  assert.equal(discovery.manifestDigest, manifest.digest);

  const changed = discoverLiveBenchBundle({
    manifest,
    sourceId: "livebench",
    indexSnapshot: indexSnapshot(indexBody.replace("abcdef12", "1234abcd")),
  });
  assert.equal(changed.bundle.url, "https://livebench.ai/static/js/main.1234abcd.js");
  assert.notEqual(changed.bundle.sourceId, discovery.bundle.sourceId);
});

test("derives a reviewable current release and exact artifact locators from official bundle bytes", () => {
  const result = resolveLiveBenchDiscovery({
    manifest,
    sourceId: "livebench",
    indexSnapshot: indexSnapshot(),
    bundleSnapshot: bundleSnapshot(),
  });
  assert.match(result.id, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.revisions, ["2024-06-24", "2025-05-30", "2026-06-25"]);
  assert.equal(result.currentRevision, "2026-06-25");
  assert.deepEqual(result.artifacts.map((item) => [item.id, item.url]), [
    ["table", "https://livebench.ai/table_2026_06_25.csv"],
    ["categories", "https://livebench.ai/categories_2026_06_25.json"],
  ]);
  assert.equal(result.bundle.sourceRef.startsWith("forage-snapshot:"), true);
});

test("fails closed on off-origin, ambiguous, unhashed, or mismatched bundle discovery", () => {
  const badIndexes = [
    '<script src="https://evil.example/static/js/main.abcdef12.js"></script>',
    '<script src="./static/js/main.js"></script>',
    '<script src="./static/js/main.abcdef12.js"></script><script src="./static/js/main.1234abcd.js"></script>',
    '<script data-src="./static/js/main.abcdef12.js"></script>',
  ];
  for (const body of badIndexes) {
    assert.throws(
      () => discoverLiveBenchBundle({ manifest, sourceId: "livebench", indexSnapshot: indexSnapshot(body) }),
      (error: unknown) => error instanceof BearingError && error.code === "INVALID_SOURCE_DISCOVERY",
    );
  }
  assert.throws(
    () => resolveLiveBenchDiscovery({
      manifest,
      sourceId: "livebench",
      indexSnapshot: indexSnapshot(),
      bundleSnapshot: bundleSnapshot(bundleBody, "https://livebench.ai/static/js/main.1234abcd.js"),
    }),
    /approved source identity/,
  );
});

test("rejects a manifest mutated after review and digesting", () => {
  const mutable = structuredClone(manifest);
  mutable.sources[0].resolver.entrypoint.url = "https://livebench.ai/changed";
  assert.throws(
    () => discoverLiveBenchBundle({ manifest: mutable, sourceId: "livebench", indexSnapshot: indexSnapshot() }),
    /digest does not match/,
  );
});

test("does not mistake unrelated dates for releases and rejects schema drift", () => {
  const oneArray = resolveLiveBenchDiscovery({
    manifest,
    sourceId: "livebench",
    indexSnapshot: indexSnapshot(),
    bundleSnapshot: bundleSnapshot(bundleBody),
  });
  assert.equal(oneArray.revisions.includes("2026-07-01"), false);

  for (const body of [
    'const a=["2024-01-01","2025-01-01"],b=["2024-02-01","2025-02-01"];',
    'const releases=["2025-01-01","2024-01-01"];',
    'const releases=["2026-02-30","2026-03-01"];',
  ]) {
    assert.throws(
      () => resolveLiveBenchDiscovery({
        manifest,
        sourceId: "livebench",
        indexSnapshot: indexSnapshot(),
        bundleSnapshot: bundleSnapshot(body),
      }),
      (error: unknown) => error instanceof BearingError && error.code === "INVALID_SOURCE_DISCOVERY",
    );
  }
});

test("requires full exact snapshot envelopes", () => {
  const forged = indexSnapshot();
  forged.reference = { ...forged.reference, sourceId: "forged" };
  assert.throws(
    () => discoverLiveBenchBundle({ manifest, sourceId: "livebench", indexSnapshot: forged }),
    /recomputed snapshot envelope/,
  );
  const weak = { ...indexSnapshot(), integrity: "body-and-identity" as never };
  assert.throws(
    () => discoverLiveBenchBundle({ manifest, sourceId: "livebench", indexSnapshot: weak }),
    /full snapshot envelope/,
  );
  const wrongMedia = snapshot("livebench-index", "https://livebench.ai/", indexBody, { mediaType: "application/json" });
  assert.throws(
    () => discoverLiveBenchBundle({ manifest, sourceId: "livebench", indexSnapshot: wrongMedia }),
    /must be text\/html/,
  );
  const invalidTime = snapshot("livebench-index", "https://livebench.ai/", indexBody, { fetchedAt: "yesterday" });
  assert.throws(
    () => discoverLiveBenchBundle({ manifest, sourceId: "livebench", indexSnapshot: invalidTime }),
    /ISO-8601 UTC timestamp|valid canonical durable snapshot/,
  );
});
