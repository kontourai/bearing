import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const temporary = await mkdtemp(path.join(os.tmpdir(), "bearing-pack-"));
const npmCache = path.join(temporary, "npm-cache");
const consumer = path.join(temporary, "consumer");
const packageDestination = process.env.BEARING_PACK_DESTINATION
  ? path.resolve(process.env.BEARING_PACK_DESTINATION)
  : path.join(temporary, "artifacts");

try {
  await mkdir(packageDestination, { recursive: true });
  const { stdout } = await execFileAsync(
    "npm",
    [
      "pack",
      "--dry-run=false",
      "--json",
      "--pack-destination",
      packageDestination,
      "--cache",
      npmCache,
    ],
    { cwd: root, maxBuffer: 10 * 1024 * 1024 },
  );
  const entries = parsePackJson(stdout);
  if (entries.length !== 1) {
    throw new Error(`Expected one npm pack entry, found ${entries.length}.`);
  }

  const entry = entries[0];
  if (entry.name !== packageJson.name) throw new Error(`Unexpected package name: ${entry.name}`);
  if (entry.version !== packageJson.version) {
    throw new Error(`Unexpected package version: ${entry.version}`);
  }
  if (entry.bundled?.length) {
    throw new Error(`Package must not bundle dependencies: ${entry.bundled.join(", ")}`);
  }

  const files = entry.files.map((file) => file.path).sort();
  const expectedFiles = [
    "LICENSE",
    "README.md",
    "CONTEXT.md",
    "bin/bearing.mjs",
    "dist/src/api.d.ts",
    "dist/src/api.js",
    "dist/src/canonical.d.ts",
    "dist/src/canonical.js",
    "dist/src/catalog.d.ts",
    "dist/src/catalog.js",
    "dist/src/error.d.ts",
    "dist/src/error.js",
    "dist/src/index.js",
    "dist/src/index.d.ts",
    "dist/src/node/catalog-file.d.ts",
    "dist/src/node/catalog-file.js",
    "dist/src/node/index.js",
    "dist/src/node/index.d.ts",
    "dist/src/node/server.d.ts",
    "dist/src/node/server.js",
    "dist/src/rank.js",
    "dist/src/rank.d.ts",
    "dist/src/snapshot.d.ts",
    "dist/src/snapshot.js",
    "dist/src/sources/aider-polyglot.d.ts",
    "dist/src/sources/aider-polyglot.js",
    "dist/src/sources/kontour-evals.d.ts",
    "dist/src/sources/kontour-evals.js",
    "dist/src/structural.d.ts",
    "dist/src/structural.js",
    "dist/src/types.d.ts",
    "dist/src/types.js",
    "dist/src/validate.d.ts",
    "dist/src/validate.js",
    "package.json",
  ].sort();
  if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) {
    const actual = new Set(files);
    const expected = new Set(expectedFiles);
    const missing = expectedFiles.filter((file) => !actual.has(file));
    const unexpected = files.filter((file) => !expected.has(file));
    throw new Error(
      `Package contents differ from the exact allowlist. Missing: ${formatList(missing)}. ` +
        `Unexpected: ${formatList(unexpected)}.`,
    );
  }

  await mkdir(consumer);
  await writeFile(path.join(consumer, "package.json"), '{"private":true,"type":"module"}\n');
  await execFileAsync(
    "npm",
    [
      "install",
      "--dry-run=false",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--cache",
      npmCache,
      path.join(packageDestination, entry.filename),
    ],
    { cwd: consumer, maxBuffer: 10 * 1024 * 1024 },
  );
  await execFileAsync(
    "node",
    [
      "--input-type=module",
      "--eval",
      [
        'import * as core from "@kontourai/bearing";',
        'import * as adapter from "@kontourai/bearing/node";',
        'if (typeof core.compileCatalog !== "function") throw new Error("missing compileCatalog");',
        'if (typeof core.importKontourEvalsResults !== "function") throw new Error("missing importKontourEvalsResults");',
        'if (typeof core.rankCatalog !== "function") throw new Error("missing rankCatalog");',
        'if (typeof adapter.startCatalogServer !== "function") throw new Error("missing startCatalogServer");',
        'if (typeof adapter.readCatalogFile !== "function") throw new Error("missing readCatalogFile");',
      ].join("\n"),
    ],
    { cwd: consumer },
  );
  await execFileAsync(
    "node",
    [path.join(consumer, "node_modules", ".bin", "bearing"), "--help"],
    { cwd: consumer },
  );

  console.log(
    `Bearing package contents and clean-consumer checks passed: ${files.length} files; ` +
      `artifact ${path.join(packageDestination, entry.filename)}.`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function parsePackJson(output) {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Could not find npm pack JSON in output:\n${output}`);
  }
  return JSON.parse(output.slice(start, end + 1));
}

function formatList(items) {
  return items.length ? items.join(", ") : "(none)";
}
