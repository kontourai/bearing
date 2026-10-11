import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { compileCatalog, serializeCatalog } from "../src/index.js";

// Compiled to dist/tests/, so the package root is two levels up.
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "bearing.mjs");

const withCatalogFile = async (run: (file: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(path.join(tmpdir(), "bearing-cli-"));
  const file = path.join(root, "catalog.json");
  await writeFile(file, serializeCatalog(compileCatalog([], { asOf: "2026-01-01T00:00:00.000Z" })), "utf8");
  try {
    await run(file);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

// A refused invocation exits on its own. One that is wrongly accepted starts a
// server and never exits, so the timeout turns that into a visible failure.
const runCli = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 15_000 });

test("serve starts with valid options (control for the refusals below)", async () => {
  await withCatalogFile(async (file) => {
    const child = spawn(process.execPath, [CLI, "serve", "--catalog", file, "--host", "127.0.0.1", "--port", "0"]);
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let stdout = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
          if (stdout.includes("\n")) resolve(stdout.trim());
        });
        child.once("exit", (code) => reject(new Error(`CLI exited early with ${code}`)));
        setTimeout(() => reject(new Error("CLI printed no URL")), 15_000).unref();
      });
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      child.kill("SIGTERM");
    }
  });
});

for (const [label, extra, message] of [
  ["a misspelled option", ["--prot", "9999"], "Unknown option: --prot"],
  ["an option in --name=value form", ["--host=0.0.0.0"], "Unknown option: --host=0.0.0.0"],
  ["a stray positional argument", ["extra"], "Unexpected argument: extra"],
  ["a repeated option", ["--port", "0"], "--port may be given only once."],
] as const) {
  test(`serve refuses ${label} with exit 2`, async () => {
    await withCatalogFile(async (file) => {
      const result = runCli(["serve", "--catalog", file, "--port", "0", ...extra]);
      assert.equal(result.signal, null, "the CLI started a server instead of refusing the arguments");
      assert.equal(result.status, 2);
      assert.equal(result.stdout, "");
      assert.ok(result.stderr.startsWith(`${message}\n`), result.stderr);
      assert.match(result.stderr, /Usage:/);
    });
  });
}

test("an unknown command is still refused with exit 2", () => {
  const result = runCli(["frobnicate"]);
  assert.equal(result.status, 2);
  assert.ok(result.stderr.startsWith("Unknown command: frobnicate\n"), result.stderr);
});
