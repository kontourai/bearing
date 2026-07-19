import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  APPROVED_SOURCE_MANIFEST_SCHEMA_VERSION,
  BearingError,
  parseApprovedSourceManifest,
  renderApprovedArtifactUrl,
} from "../src/index.js";

const manifestPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "sources",
  "approved-sources.v1.json",
);
const source = readFileSync(manifestPath, "utf8");

test("parses the reviewed packaged source manifest deterministically", () => {
  const first = parseApprovedSourceManifest(source);
  const second = parseApprovedSourceManifest(Buffer.from(source));
  assert.deepEqual(second, first);
  assert.equal(first.schemaVersion, APPROVED_SOURCE_MANIFEST_SCHEMA_VERSION);
  assert.match(first.digest, /^[a-f0-9]{64}$/);
  assert.equal(first.sources.length, 2);
  const livebench = first.sources.find((item) => item.id === "livebench")!;
  assert.equal(livebench.id, "livebench");
  assert.equal(livebench.canonicalOrigin, "https://livebench.ai");
  assert.equal(livebench.license.identifier, "NOASSERTION");
  assert.equal(livebench.proposalPolicy.unknownRows, "review");
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(livebench.resolver), true);
  const openrouter = first.sources.find((item) => item.id === "openrouter-models")!;
  assert.equal(openrouter.revision.grammar, "sha256");
  assert.equal(openrouter.artifacts.items.length, 0);
  assert.equal(
    renderApprovedArtifactUrl(livebench, livebench.artifacts.items[0], "2026-06-25"),
    "https://livebench.ai/table_2026_06_25.csv",
  );
});

test("rejects invalid direct revision rendering and parser resource amplification", () => {
  const livebench = parseApprovedSourceManifest(source).sources[0];
  assert.throws(
    () => renderApprovedArtifactUrl(livebench, livebench.artifacts.items[0], "../../admin"),
    /calendar-date/,
  );
  const deep = `${"[".repeat(65)}0${"]".repeat(65)}`;
  assert.throws(() => parseApprovedSourceManifest(deep), /maximum JSON depth/);
  assert.throws(() => parseApprovedSourceManifest(`${source}\ud800`), /UTF-8/);
});

test("rejects duplicate keys and source ids rather than silently changing trust policy", () => {
  const duplicateKey = source.replace(
    '"schemaVersion": "bearing.approved-source-manifest/v1",',
    '"schemaVersion": "bearing.approved-source-manifest/v1",\n  "schemaVersion": "bearing.approved-source-manifest/v1",',
  );
  assert.throws(
    () => parseApprovedSourceManifest(duplicateKey),
    (error: unknown) => error instanceof BearingError && error.code === "INVALID_SOURCE_MANIFEST" && /duplicate/.test(error.message),
  );
  const parsed = JSON.parse(source) as { sources: unknown[] };
  parsed.sources.push(parsed.sources[0]);
  assert.throws(() => parseApprovedSourceManifest(JSON.stringify(parsed)), /unique source ids/);
  const unsafe = source.replace('"proposalPolicy": {', '"__proto__": {"polluted": true},\n      "proposalPolicy": {');
  assert.throws(() => parseApprovedSourceManifest(unsafe), /forbidden key __proto__/);
});

test("rejects unregistered adapters, unsafe URLs, hidden parse instructions, and impossible freshness", () => {
  const cases: Array<(manifest: Record<string, any>) => void> = [
    (manifest) => { manifest.sources[0].resolver.adapter = "arbitrary-code"; },
    (manifest) => { manifest.sources[0].resolver.entrypoint.url = "http://livebench.ai/"; },
    (manifest) => { manifest.sources[0].artifacts.items[0].urlTemplate = "https://evil.example/{revision}"; },
    (manifest) => { manifest.sources[0].resolver.parseExpression = "eval(source)"; },
    (manifest) => { manifest.sources[0].freshness.maxAgeHours = 1; },
    (manifest) => { manifest.sources[0].artifacts.items = []; },
    (manifest) => {
      manifest.sources[0].canonicalOrigin = "https://attacker.example/";
      manifest.sources[0].resolver.entrypoint.url = "https://attacker.example/";
      manifest.sources[0].artifacts.items[0].urlTemplate = "https://attacker.example/table_{revision_underscore}.csv";
      manifest.sources[0].artifacts.items[1].urlTemplate = "https://attacker.example/categories_{revision_underscore}.json";
    },
    (manifest) => {
      manifest.sources[1].canonicalOrigin = "https://attacker.example/";
      manifest.sources[1].resolver.entrypoint.url = "https://attacker.example/models";
    },
  ];
  for (const mutate of cases) {
    const parsed = JSON.parse(source) as Record<string, any>;
    mutate(parsed);
    assert.throws(
      () => parseApprovedSourceManifest(JSON.stringify(parsed)),
      (error: unknown) => error instanceof BearingError && error.code === "INVALID_SOURCE_MANIFEST",
    );
  }
});

test("approves exact content-addressed source identities rather than compatible adapter names", () => {
  const livebenchDirect = JSON.parse(source) as Record<string, any>;
  livebenchDirect.sources[0].resolver.derivedResourcePolicy = "direct-entrypoint/v1";
  livebenchDirect.sources[0].artifacts.items = [];
  assert.throws(() => parseApprovedSourceManifest(JSON.stringify(livebenchDirect)), /approved content-addressed source identity/);

  const openrouterDerived = JSON.parse(source) as Record<string, any>;
  openrouterDerived.sources[1].artifacts.items = [{
    id: "unexpected",
    required: true,
    urlTemplate: "https://openrouter.ai/{revision}",
    mediaType: "application/json",
    maxBytes: 1024,
  }];
  assert.throws(() => parseApprovedSourceManifest(JSON.stringify(openrouterDerived)), /approved content-addressed source identity/);
});
