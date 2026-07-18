import { canonicalJson } from "./canonical.js";
import { validateCatalogSnapshot } from "./snapshot.js";
import type { CatalogSnapshot } from "./types.js";

export interface CatalogHandlerOptions {
  catalog: CatalogSnapshot;
}

export type CatalogHandler = (request: Request) => Promise<Response>;

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

  const notModified = (request: Request): Response | null =>
    matchesEtag(request.headers.get("if-none-match"), etag)
      ? new Response(null, { status: 304, headers: responseHeaders(catalog) })
      : null;

  return async (request: Request): Promise<Response> => {
    const head = request.method === "HEAD";
    if (request.method !== "GET" && !head) {
      return errorResponse(catalog, 405, "METHOD_NOT_ALLOWED", "Only GET and HEAD are supported.", false, { allow: "GET, HEAD" });
    }
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0]?.startsWith("v") && segments[0] !== "v1") {
      return errorResponse(catalog, 404, "UNSUPPORTED_API_VERSION", `Unsupported API version ${segments[0]}.`, head);
    }
    if (segments[0] !== "v1") {
      return errorResponse(catalog, 404, "NOT_FOUND", "Endpoint not found.", head);
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
