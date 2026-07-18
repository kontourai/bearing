import { canonicalJson } from "./canonical.js";
import { compileCatalog, normalizeObservation } from "./catalog.js";
import { BearingError } from "./error.js";
import {
  CATALOG_SCHEMA_VERSION,
  type CatalogSnapshot,
  type ObservationInput,
} from "./types.js";

const invalid = (path: string, message: string, cause?: unknown): never => {
  const suffix = cause instanceof Error ? `: ${cause.message}` : "";
  throw new BearingError("INVALID_CATALOG", path, `${message}${suffix}`);
};

const record = (value: unknown, path: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(path, "must be an object");
  }
  return value as Record<string, unknown>;
};

export const validateCatalogSnapshot = (value: unknown): CatalogSnapshot => {
  const snapshot = record(value, "$");
  if (snapshot.schemaVersion !== CATALOG_SCHEMA_VERSION) {
    throw new BearingError(
      "UNSUPPORTED_CATALOG_SCHEMA",
      "$.schemaVersion",
      `expected ${CATALOG_SCHEMA_VERSION}`,
    );
  }
  if (typeof snapshot.asOf !== "string") invalid("$.asOf", "must be a string");
  if (!Array.isArray(snapshot.models)) invalid("$.models", "must be an array");

  const inputs: ObservationInput[] = [];
  const models = snapshot.models as unknown[];
  for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
    const model = record(models[modelIndex], `$.models[${modelIndex}]`);
    if (!Array.isArray(model.observations)) {
      invalid(`$.models[${modelIndex}].observations`, "must be an array");
    }
    const observations = model.observations as unknown[];
    for (let observationIndex = 0; observationIndex < observations.length; observationIndex += 1) {
      const path = `$.models[${modelIndex}].observations[${observationIndex}]`;
      const raw = record(observations[observationIndex], path);
      if (typeof raw.id !== "string") invalid(`${path}.id`, "must be a string");
      const { id, ...input } = raw;
      try {
        const normalized = normalizeObservation(input as unknown as ObservationInput);
        if (normalized.id !== id) invalid(`${path}.id`, "does not match normalized observation content");
        inputs.push(input as unknown as ObservationInput);
      } catch (error) {
        if (error instanceof BearingError && error.code === "INVALID_CATALOG") throw error;
        invalid(path, "contains an invalid observation", error);
      }
    }
  }

  const compiled = (() => {
    try {
      return compileCatalog(inputs, { asOf: snapshot.asOf as string });
    } catch (error) {
      return invalid("$", "cannot be recompiled", error);
    }
  })();
  if (canonicalJson(compiled) !== canonicalJson(snapshot)) {
    invalid("$", "does not match its deterministically recompiled content");
  }
  return compiled;
};

export const parseCatalog = (text: string): CatalogSnapshot => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    invalid("$", "is not valid JSON", error);
  }
  return validateCatalogSnapshot(parsed);
};

export const serializeCatalog = (catalog: CatalogSnapshot): string =>
  canonicalJson(validateCatalogSnapshot(catalog));
