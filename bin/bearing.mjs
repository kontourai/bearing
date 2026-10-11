#!/usr/bin/env node

import { readCatalogFile, startCatalogServer } from "../dist/src/node/index.js";

const usage = `Usage:
  bearing serve --catalog <file> [--host <host>] [--port <port>]
    [--max-concurrent-rank-requests <count>] [--max-rank-response-bytes <bytes>]
  bearing --help`;

const fail = (message) => {
  process.stderr.write(`${message}\n${usage}\n`);
  process.exitCode = 2;
};

const SERVE_OPTIONS = new Set([
  "--catalog",
  "--host",
  "--port",
  "--max-concurrent-rank-requests",
  "--max-rank-response-bytes",
]);

// Every serve option takes a value. Anything else (a misspelled option, a
// stray positional, or a repeated option) is a usage error rather than being
// ignored, so a typo can never silently fall back to a default.
const parseServeOptions = (args) => {
  const options = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!SERVE_OPTIONS.has(name)) {
      fail(name.startsWith("-") ? `Unknown option: ${name}` : `Unexpected argument: ${name}`);
      return undefined;
    }
    if (options.has(name)) {
      fail(`${name} may be given only once.`);
      return undefined;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`${name} requires a value.`);
      return undefined;
    }
    options.set(name, value);
    index += 1;
  }
  return options;
};

const positiveIntegerFor = (options, name) => {
  const raw = options.get(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`${name} must be a positive safe integer.`);
    return undefined;
  }
  return value;
};

const main = async () => {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (args[0] !== "serve") {
    fail(`Unknown command: ${args[0]}`);
    return;
  }
  const options = parseServeOptions(args.slice(1));
  if (options === undefined) return;
  const catalogFile = options.get("--catalog");
  if (catalogFile === undefined) {
    fail("--catalog is required.");
    return;
  }
  const configuredHost = options.get("--host");
  const configuredPort = options.get("--port");
  const maxConcurrentRankRequests = positiveIntegerFor(options, "--max-concurrent-rank-requests");
  const maxRankResponseBytes = positiveIntegerFor(options, "--max-rank-response-bytes");
  if (process.exitCode) return;
  const host = configuredHost ?? "127.0.0.1";
  const rawPort = configuredPort ?? "4244";
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    fail("--port must be an integer from 0 through 65535.");
    return;
  }
  const server = await startCatalogServer({
    catalog: await readCatalogFile(catalogFile),
    host,
    port,
    ...(maxConcurrentRankRequests === undefined ? {} : { maxConcurrentRankRequests }),
    ...(maxRankResponseBytes === undefined ? {} : { maxRankResponseBytes }),
  });
  process.stdout.write(`${server.url}\n`);
  const stop = async () => {
    await server.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
};

main().catch((error) => {
  process.stderr.write(`bearing: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
