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
const bundleBody = '(()=>{const releases=["2024-06-24","2024-07-26","2024-08-31","2026-06-25"],latest=releases[releases.length-1];function View(){useState(latest);return {releases}}jsx(View,{})})();';

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
  assert.deepEqual(result.revisions, ["2024-06-24", "2024-07-26", "2024-08-31", "2026-06-25"]);
  assert.equal(result.currentRevision, "2026-06-25");
  assert.deepEqual(result.artifacts.map((item) => [item.id, item.url]), [
    ["table", "https://livebench.ai/table_2026_06_25.csv"],
    ["categories", "https://livebench.ai/categories_2026_06_25.json"],
  ]);
  assert.equal(result.bundle.sourceRef.startsWith("forage-snapshot:"), true);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.artifacts), true);
  assert.throws(() => (result.artifacts as unknown as Array<{ url: string }>)[0].url = "https://evil.example/table.csv", TypeError);
});

test("fails closed on off-origin, ambiguous, unhashed, or mismatched bundle discovery", () => {
  const badIndexes = [
    '<script src="https://evil.example/static/js/main.abcdef12.js"></script>',
    '<script src="./static/js/main.js"></script>',
    '<script src="./static/js/main.abcdef12.js"></script><script src="./static/js/main.1234abcd.js"></script>',
    '<script data-src="./static/js/main.abcdef12.js"></script>',
    '<!-- <script src="./static/js/main.abcdef12.js"></script> -->',
    '<template><script src="./static/js/main.abcdef12.js"></script></template>',
    '<script type="application/json" src="./static/js/main.abcdef12.js"></script>',
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
  const mutable = structuredClone(manifest) as any;
  mutable.sources[0].resolver.entrypoint.url = "https://livebench.ai/changed";
  assert.throws(
    () => discoverLiveBenchBundle({ manifest: mutable, sourceId: "livebench", indexSnapshot: indexSnapshot() }),
    /parsed approved source manifest/,
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
    'const a=["2024-06-24","2024-07-26","2024-08-31"],b=["2024-06-24","2024-07-26","2024-08-31"];',
    'const releases=["2024-06-24","2024-07-26","2024-08-31","2024-01-01"];',
    'const releases=["2024-06-24","2024-07-26","2024-08-31","2026-02-30"];',
    'const unrelated="[\\"2024-06-24\\",\\"2024-07-26\\",\\"2024-08-31\\",\\"2026-01-01\\"]";',
    'const copyrightDates=["2025-01-01","2026-01-01"];',
    'if(false){const releases=["2024-06-24","2024-07-26","2024-08-31"],latest=releases[releases.length-1];const view={releases}}',
    'const = ; (()=>{const releases=["2024-06-24","2024-07-26","2024-08-31"],latest=releases[releases.length-1];const view={releases}})();',
    '(()=>{const releases=["2024-06-24","2024-07-26","2024-08-31"],latest=releases[releases.length-1];function neverCalled(){useState(latest);return {releases}}})();',
    '(()=>{return;const releases=["2024-06-24","2024-07-26","2024-08-31"],latest=releases[releases.length-1];function View(){useState(latest);return {releases}}jsx(View,{})})();',
    'if(false){(()=>{const releases=["2024-06-24","2024-07-26","2024-08-31"],latest=releases[releases.length-1];function View(){useState(latest);return {releases}}jsx(View,{})})()}',
    '(()=>{const releases=["2024-06-24","2024-07-26","2024-08-31"];return;const latest=releases[releases.length-1];function View(){useState(latest);return {releases}}jsx(View,{})})();',
    '(()=>{throw Error();const releases=["2024-06-24","2024-07-26","2024-08-31"],latest=releases[releases.length-1];function View(){useState(latest);return {releases}}jsx(View,{})})();',
    '(()=>{const releases=["2024-06-24","2024-07-26","2024-08-31"],latest=releases[releases.length-1];function View(){if(false){useState(latest);return {releases}}}jsx(View,{})})();',
    '(()=>{const releases=["2024-06-24","2024-07-26","2024-08-31"],latest=releases[releases.length-1];function View(){useState(latest);return {releases}}if(false){jsx(View,{})}})();',
    '(()=>{const releases=["2024-06-24","2024-07-26","2024-08-31"],latest=releases[releases[length]-1];function View(){useState(latest);return {releases}}jsx(View,{})})();',
    '(()=>{const releases=["2024-06-24","2024-07-26","2024-08-31"],latest=releases[releases.length-1];function View(releases,latest){useState(latest);return {releases}}jsx(View,{})})();',
    '(()=>{const releases=["2024-06-24","2024-07-26","2024-08-31"],latest=releases[releases.length-1];function View(){false&&useState(latest);return {releases}}jsx(View,{})})();',
    '(()=>{const releases=["2024-06-24","2024-07-26","2024-08-31"],latest=releases[releases.length-1];function View(){useState(latest);return {releases}}false&&jsx(View,{})})();',
    '(()=>{const releases=["2024-06-24","2024-07-26","2024-08-31"],latest=releases[releases.length-1];function View(){function latest(){}useState(latest);return {releases}}jsx(View,{})})();',
    '(()=>{const releases=["2024-06-24","2024-07-26","2024-08-31"],latest=releases[releases.length-1];function View(){class releases{}useState(latest);return {releases}}jsx(View,{})})();',
    '(()=>{const releases=["2024-06-24","2024-07-26","2024-08-31"],latest=releases[releases.length-1];function View(){useState(latest);return {releases}}{const View=Other;jsx(View,{})}})();',
    'false&&(()=>{const releases=["2024-06-24","2024-07-26","2024-08-31"],latest=releases[releases.length-1];function View(){useState(latest);return {releases}}jsx(View,{})})();',
    '(()=>{const releases=["2024-06-24","2024-07-26","2024-08-31"],latest=releases[releases.length-1];function View(){null?.(latest);return {releases}}jsx(View,{})})();',
    '(()=>{const releases=["2024-06-24","2024-07-26","2024-08-31"],latest=releases[releases.length-1];function View(){class Decoy{x=useState(latest);y={releases}}}jsx(View,{})})();',
    '(()=>{const releases=["2024-06-24","2024-07-26","2024-08-31"],latest=releases[releases.length-1];function View(){useState(latest);return {releases}}with({View:Other})jsx(View,{})})();',
    '(()=>{const latest=releases[releases.length-1],releases=["2024-06-24","2024-07-26","2024-08-31"];function View(){useState(latest);return {releases}}jsx(View,{})})();',
    '(()=>{const releases=["2024-06-24","2024-07-26","2024-08-31"],latest=releases[releases.length-1];latest=Other;function View(){useState(latest);return {releases}}jsx(View,{})})();',
    '(()=>{const releases=["2024-06-24","2024-07-26","2024-08-31"],latest=releases[releases.length-1];function View(){useState(latest);return {releases}}View=Other;jsx(View,{})})();',
    '(()=>{if(true){return}const releases=["2024-06-24","2024-07-26","2024-08-31"],latest=releases[releases.length-1];function View(){useState(latest);return {releases}}jsx(View,{})})();',
    '(()=>{const releases=["2024-06-24","2024-07-26","2024-08-31"],latest=releases[releases.length-1];if(true){latest=Other}function View(){useState(latest);return {releases}}jsx(View,{})})();',
    '(()=>{const releases=["2024-06-24","2024-07-26","2024-08-31"],latest=releases[releases.length-1];(()=>{latest=Other})();function View(){useState(latest);return {releases}}jsx(View,{})})();',
    '(()=>{const releases=["2024-06-24","2024-07-26","2024-08-31"],latest=releases[releases.length-1];function View(){if(false){var latest}useState(latest);return {releases}}jsx(View,{})})();',
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
  const missingReference = { ...indexSnapshot(), reference: undefined } as any;
  assert.throws(
    () => discoverLiveBenchBundle({ manifest, sourceId: "livebench", indexSnapshot: missingReference }),
    (error: unknown) => error instanceof BearingError && error.code === "INVALID_SOURCE_DISCOVERY",
  );
  assert.throws(
    () => discoverLiveBenchBundle({ manifest: null as any, sourceId: "livebench", indexSnapshot: indexSnapshot() }),
    (error: unknown) => error instanceof BearingError && error.code === "INVALID_SOURCE_DISCOVERY",
  );
});
