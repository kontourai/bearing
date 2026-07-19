import { canonicalJson } from "./canonical.js";
import { BearingError } from "./error.js";
import { createCatalogRanker, type AnyRankRequest } from "./rank.js";
import { validateCatalogSnapshot } from "./snapshot.js";
import type { CatalogSnapshot } from "./types.js";

export interface CatalogHandlerOptions {
  catalog: CatalogSnapshot;
  maxConcurrentRankRequests?: number;
  maxRankResponseBytes?: number;
}

export type CatalogHandler = (request: Request) => Promise<Response>;
export const MAX_RANK_REQUEST_BYTES = 1_048_576;
export const DEFAULT_MAX_CONCURRENT_RANK_REQUESTS = 4;
export const DEFAULT_MAX_RANK_RESPONSE_BYTES = 8 * 1_048_576;

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

const positiveInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer.`);
  return value;
};

const readRequestTextLimited = async (request: Request, maxBytes: number): Promise<string | null> => {
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    reader.releaseLock();
  }
};

const matchesEtag = (header: string | null, etag: string): boolean => {
  if (header === null) return false;
  return header.split(",").some((candidate) => {
    const normalized = candidate.trim().replace(/^W\//, "");
    return normalized === "*" || normalized === etag;
  });
};

const responseHeaders = (catalog: CatalogSnapshot, contentType = "application/json; charset=utf-8"): Headers => new Headers({
  "cache-control": "public, max-age=0, must-revalidate",
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "ETag, X-Bearing-Catalog-As-Of, X-Bearing-Catalog-Digest",
  "content-type": contentType,
  etag: `"bearing-${catalog.digest}"`,
  "x-bearing-catalog-as-of": catalog.asOf,
  "x-bearing-catalog-digest": catalog.digest,
});

const jsonResponse = (
  catalog: CatalogSnapshot,
  body: unknown,
  status = 200,
  head = false,
  extraHeaders?: Record<string, string>,
): Response => {
  const headers = responseHeaders(catalog);
  for (const [key, value] of Object.entries(extraHeaders ?? {})) headers.set(key, value);
  return new Response(head ? null : canonicalJson(body), { status, headers });
};

const serializedJsonResponse = (
  catalog: CatalogSnapshot,
  body: string,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response => {
  const headers = responseHeaders(catalog);
  for (const [key, value] of Object.entries(extraHeaders ?? {})) headers.set(key, value);
  return new Response(body, { status, headers });
};

const errorResponse = (
  catalog: CatalogSnapshot,
  status: number,
  code: string,
  message: string,
  head: boolean,
  extraHeaders?: Record<string, string>,
): Response => jsonResponse(catalog, {
  schemaVersion: "bearing.api.error/v1",
  error: { code, message },
  catalog: { digest: catalog.digest, asOf: catalog.asOf },
}, status, head, extraHeaders);

export const createCatalogHandler = (options: CatalogHandlerOptions): CatalogHandler => {
  const catalog = validateCatalogSnapshot(options.catalog);
  const maxConcurrentRankRequests = positiveInteger(
    options.maxConcurrentRankRequests ?? DEFAULT_MAX_CONCURRENT_RANK_REQUESTS,
    "maxConcurrentRankRequests",
  );
  const maxRankResponseBytes = positiveInteger(
    options.maxRankResponseBytes ?? DEFAULT_MAX_RANK_RESPONSE_BYTES,
    "maxRankResponseBytes",
  );
  const etag = `"bearing-${catalog.digest}"`;
  const serializedCatalog = canonicalJson(catalog);
  const modelsByKey = new Map(catalog.models.map((model) => [model.key, model]));
  const conflictsByModel = new Map<string, typeof catalog.conflicts>();
  for (const conflict of catalog.conflicts) {
    const conflicts = conflictsByModel.get(conflict.modelKey) ?? [];
    conflicts.push(conflict);
    conflictsByModel.set(conflict.modelKey, conflicts);
  }
  const modelList = catalog.models.map((model) => ({
    key: model.key,
    identity: model.identity,
    observationCount: model.observations.length,
    conflictCount: conflictsByModel.get(model.key)?.length ?? 0,
  }));
  const rank = createCatalogRanker(catalog);
  let activeRankRequests = 0;

  const notModified = (request: Request): Response | null =>
    matchesEtag(request.headers.get("if-none-match"), etag)
      ? new Response(null, { status: 304, headers: responseHeaders(catalog) })
      : null;

  return async (request: Request): Promise<Response> => {
    const head = request.method === "HEAD";
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0]?.startsWith("v") && segments[0] !== "v1") {
      return errorResponse(catalog, 404, "UNSUPPORTED_API_VERSION", `Unsupported API version ${segments[0]}.`, head);
    }
    if (segments[0] !== "v1") {
      return errorResponse(catalog, 404, "NOT_FOUND", "Endpoint not found.", head);
    }

    if (segments.length === 2 && segments[1] === "rank") {
      if (request.method === "OPTIONS") {
        const headers = responseHeaders(catalog);
        headers.set("access-control-allow-headers", "Content-Type");
        headers.set("access-control-allow-methods", "POST, OPTIONS");
        headers.set("allow", "POST, OPTIONS");
        return new Response(null, { status: 204, headers });
      }
      if (request.method !== "POST") {
        return errorResponse(catalog, 405, "METHOD_NOT_ALLOWED", "Only POST is supported.", head, { allow: "POST, OPTIONS" });
      }
      const declaredLength = Number(request.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RANK_REQUEST_BYTES) {
        void request.body?.cancel().catch(() => undefined);
        return errorResponse(catalog, 413, "PAYLOAD_TOO_LARGE", `Rank requests are limited to ${MAX_RANK_REQUEST_BYTES} bytes.`, false);
      }
      if (activeRankRequests >= maxConcurrentRankRequests) {
        void request.body?.cancel().catch(() => undefined);
        return errorResponse(catalog, 503, "RANK_CAPACITY_EXCEEDED", "Rank request capacity is currently exhausted.", false, { "retry-after": "1" });
      }
      activeRankRequests++;
      try {
        const body = await readRequestTextLimited(request, MAX_RANK_REQUEST_BYTES);
        if (body === null) {
          return errorResponse(catalog, 413, "PAYLOAD_TOO_LARGE", `Rank requests are limited to ${MAX_RANK_REQUEST_BYTES} bytes.`, false);
        }
        try {
          const serialized = canonicalJson(rank(JSON.parse(body) as AnyRankRequest));
          if (byteLength(serialized) > maxRankResponseBytes) {
            return errorResponse(catalog, 422, "RANK_RESULT_TOO_LARGE", `Rank results are limited to ${maxRankResponseBytes} bytes.`, false);
          }
          return serializedJsonResponse(catalog, serialized);
        } catch (error) {
          if (error instanceof SyntaxError || (error instanceof BearingError && error.code === "INVALID_RANK_REQUEST")) {
            return errorResponse(catalog, 400, "INVALID_RANK_REQUEST", error.message, false);
          }
          throw error;
        }
      } finally {
        activeRankRequests--;
      }
    }

    if (request.method !== "GET" && !head) {
      return errorResponse(catalog, 405, "METHOD_NOT_ALLOWED", "Only GET and HEAD are supported.", false, { allow: "GET, HEAD" });
    }

    if (segments.length === 2 && segments[1] === "models") {
      const conditional = notModified(request);
      if (conditional !== null) return conditional;
      return jsonResponse(catalog, {
        schemaVersion: "bearing.api.models/v1",
        catalog: { digest: catalog.digest, asOf: catalog.asOf },
        models: modelList,
      }, 200, head);
    }

    if (segments.length === 3 && segments[1] === "models") {
      const model = modelsByKey.get(segments[2]);
      if (model === undefined) {
        return errorResponse(catalog, 404, "MODEL_NOT_FOUND", `Model ${segments[2]} was not found.`, head);
      }
      const conditional = notModified(request);
      if (conditional !== null) return conditional;
      return jsonResponse(catalog, {
        schemaVersion: "bearing.api.model/v1",
        catalog: { digest: catalog.digest, asOf: catalog.asOf },
        model,
        conflicts: conflictsByModel.get(model.key) ?? [],
      }, 200, head);
    }

    if (segments.length === 3 && segments[1] === "catalog" && segments[2] === "snapshot") {
      const conditional = notModified(request);
      if (conditional !== null) return conditional;
      const headers = responseHeaders(catalog);
      return new Response(head ? null : serializedCatalog, { status: 200, headers });
    }
    return errorResponse(catalog, 404, "NOT_FOUND", "Endpoint not found.", head);
  };
};
