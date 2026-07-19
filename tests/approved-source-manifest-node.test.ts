import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  loadPackagedApprovedSourceManifest,
  readApprovedSourceManifest,
} from "../src/node/index.js";

test("Node adapter loads the packaged or explicitly selected approved source manifest", async () => {
  const packaged = await loadPackagedApprovedSourceManifest();
  const sourcePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "sources",
    "approved-sources.v1.json",
  );
  const explicit = await readApprovedSourceManifest(sourcePath);
  assert.deepEqual(explicit, packaged);
  assert.equal((await readFile(sourcePath, "utf8")).includes('"id": "livebench"'), true);
});
