import { getNodeValue, parseTree, type Node, type ParseError } from "jsonc-parser";

import { sha256 } from "../canonical.js";
import { BearingError } from "../error.js";

export const APPROVED_SOURCE_MANIFEST_SCHEMA_VERSION = "bearing.approved-source-manifest/v1" as const;

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_SOURCES = 128;
const MAX_TEXT_CHARACTERS = 8_192;
const MAX_ARTIFACTS = 32;
const MAX_LIMIT_BYTES = 64 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_STRUCTURAL_TOKENS = 100_000;
const parsedManifests = new WeakSet<object>();
const forbiddenObjectKeys = new Set(["__proto__", "constructor", "prototype"]);

export interface ApprovedSourceArtifact {
  readonly id: string;
  readonly required: boolean;
  readonly urlTemplate: string;
  readonly mediaType: string;
  readonly maxBytes: number;
}

export interface ApprovedSource {
  readonly id: string;
  readonly owner: string;
  readonly sourceClass: "external";
  readonly canonicalOrigin: string;
  readonly attribution: {
    readonly name: string;
    readonly url: string;
  };
  readonly license: {
    readonly identifier: string;
    readonly evidenceUrl: string | null;
  };
  readonly trustRationale: string;
  readonly knownLimitations: readonly string[];
  readonly freshness: {
    readonly refreshIntervalHours: number;
    readonly maxAgeHours: number;
  };
  readonly revision: {
    readonly kind: "release" | "commit" | "opaque" | "snapshot";
    readonly grammar: "calendar-date" | "full-git-sha" | "opaque-token" | "sha256";
  };
  readonly resolver: {
    readonly adapter: string;
    readonly version: string;
    readonly entrypoint: {
      readonly sourceId: string;
      readonly url: string;
      readonly mediaType: string;
      readonly maxBytes: number;
    };
    readonly derivedResourcePolicy: string;
    readonly maxBytes: number;
  };
  readonly artifacts: {
    readonly adapter: string;
    readonly version: string;
    readonly items: readonly ApprovedSourceArtifact[];
  };
  readonly proposalPolicy: {
    readonly newRevision: "review";
    readonly unknownRows: "review";
    readonly mappingChanges: "review";
  };
}

export interface ApprovedSourceManifest {
  readonly schemaVersion: typeof APPROVED_SOURCE_MANIFEST_SCHEMA_VERSION;
  readonly sources: readonly ApprovedSource[];
  readonly digest: string;
}

export interface ApprovedSourceRegistry {
  readonly sources: ReadonlyArray<{
    readonly id: string;
    readonly digest: string;
  }>;
}

export const DEFAULT_APPROVED_SOURCE_REGISTRY: ApprovedSourceRegistry = Object.freeze({
  sources: Object.freeze([
    Object.freeze({
      id: "livebench",
      digest: "3ea9391905f64dd90ff23298f54c900271d50b99e5dac19f4f3ede06a482ee14",
    }),
    Object.freeze({
      id: "openrouter-models",
      digest: "ba877e92c78601d7f6b2d2ce69e3dcc0074236295e19b4fa43c0b79c559f0f5c",
    }),
  ]),
});

export const isDefaultApprovedSourceIdentity = (source: ApprovedSource): boolean => {
  const approved = DEFAULT_APPROVED_SOURCE_REGISTRY.sources.find((entry) => entry.id === source.id);
  return approved !== undefined && sha256(source) === approved.digest;
};

const fail = (path: string, message: string): never => {
  throw new BearingError("INVALID_SOURCE_MANIFEST", path, message);
};

const record = (value: unknown, path: string): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : fail(path, "must be an object");

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    return fail(path, `must contain exactly: ${wanted.join(", ")}`);
  }
};

const text = (value: unknown, path: string): string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT_CHARACTERS && value.trim() === value
    ? value
    : fail(path, `must be a trimmed non-empty string of at most ${MAX_TEXT_CHARACTERS} characters`);

const integer = (value: unknown, path: string, maximum = MAX_LIMIT_BYTES): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum
    ? value
    : fail(path, `must be a positive safe integer no greater than ${maximum}`);

const httpsUrl = (value: unknown, path: string): string => {
  const raw = text(value, path);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return fail(path, "must be an absolute HTTPS URL");
  }
  if (
    parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" ||
    parsed.hash !== "" || parsed.hostname === "" || parsed.hostname.endsWith(".")
  ) {
    return fail(path, "must be a credential-free, fragment-free absolute HTTPS URL");
  }
  return parsed.href;
};

const assertSameOrigin = (url: string, origin: string, path: string): void => {
  if (new URL(url).origin !== origin) return fail(path, "must use the source canonical origin");
};

const assertUniqueObjectKeys = (root: Node): void => {
  const pending: Array<{ node: Node; path: string }> = [{ node: root, path: "$" }];
  while (pending.length > 0) {
    const { node, path } = pending.pop()!;
    if (node.type === "object") {
      const seen = new Set<string>();
      for (const property of node.children ?? []) {
        const keyNode = property.children?.[0];
        const valueNode = property.children?.[1];
        if (keyNode === undefined || typeof keyNode.value !== "string" || valueNode === undefined) {
          return fail(path, "must contain complete JSON properties");
        }
        if (seen.has(keyNode.value)) return fail(`${path}.${keyNode.value}`, "must not duplicate an object key");
        if (forbiddenObjectKeys.has(keyNode.value)) return fail(`${path}.${keyNode.value}`, `contains forbidden key ${keyNode.value}`);
        seen.add(keyNode.value);
        pending.push({ node: valueNode, path: `${path}.${keyNode.value}` });
      }
    } else if (node.type === "array") {
      (node.children ?? []).forEach((child, index) => pending.push({ node: child, path: `${path}[${index}]` }));
    }
  }
};

const preflightJsonBounds = (body: string): void => {
  let depth = 0;
  let structuralTokens = 0;
  let inString = false;
  let escaped = false;
  for (const character of body) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") {
      depth += 1;
      structuralTokens += 1;
      if (depth > MAX_JSON_DEPTH) return fail("$", `exceeds maximum JSON depth ${MAX_JSON_DEPTH}`);
    } else if (character === "}" || character === "]") {
      depth -= 1;
      structuralTokens += 1;
      if (depth < 0) return fail("$", "must have balanced JSON structure");
    } else if (character === "," || character === ":") {
      structuralTokens += 1;
    }
    if (structuralTokens > MAX_JSON_STRUCTURAL_TOKENS) {
      return fail("$", `exceeds ${MAX_JSON_STRUCTURAL_TOKENS} JSON structural tokens`);
    }
  }
};

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
};

const parseArtifact = (value: unknown, path: string, origin: string): ApprovedSourceArtifact => {
  const item = record(value, path);
  exactKeys(item, ["id", "required", "urlTemplate", "mediaType", "maxBytes"], path);
  const id = text(item.id, `${path}.id`);
  const urlTemplate = text(item.urlTemplate, `${path}.urlTemplate`);
  const placeholders = urlTemplate.match(/\{[^}]+\}/g) ?? [];
  if (
    placeholders.length !== 1 ||
    (placeholders[0] !== "{revision}" && placeholders[0] !== "{revision_underscore}")
  ) {
    return fail(`${path}.urlTemplate`, "must contain exactly one supported revision placeholder");
  }
  const sampleUrl = httpsUrl(urlTemplate.replace(placeholders[0], "2000-01-01"), `${path}.urlTemplate`);
  assertSameOrigin(sampleUrl, origin, `${path}.urlTemplate`);
  if (typeof item.required !== "boolean") return fail(`${path}.required`, "must be boolean");
  return {
    id,
    required: item.required,
    urlTemplate,
    mediaType: text(item.mediaType, `${path}.mediaType`),
    maxBytes: integer(item.maxBytes, `${path}.maxBytes`),
  };
};

const parseFreshness = (value: unknown, path: string): ApprovedSource["freshness"] => {
  const item = record(value, path);
  exactKeys(item, ["refreshIntervalHours", "maxAgeHours"], path);
  const refreshIntervalHours = integer(item.refreshIntervalHours, `${path}.refreshIntervalHours`, 24 * 365);
  const maxAgeHours = integer(item.maxAgeHours, `${path}.maxAgeHours`, 24 * 365 * 10);
  if (maxAgeHours < refreshIntervalHours) return fail(`${path}.maxAgeHours`, "must be at least refreshIntervalHours");
  return { refreshIntervalHours, maxAgeHours };
};

const parseRevision = (value: unknown, path: string): ApprovedSource["revision"] => {
  const item = record(value, path);
  exactKeys(item, ["kind", "grammar"], path);
  const kinds = ["release", "commit", "opaque", "snapshot"] as const;
  const grammars = ["calendar-date", "full-git-sha", "opaque-token", "sha256"] as const;
  if (!kinds.includes(item.kind as never)) return fail(`${path}.kind`, "is unsupported");
  if (!grammars.includes(item.grammar as never)) return fail(`${path}.grammar`, "is unsupported");
  if (
    (item.kind === "release" && item.grammar !== "calendar-date") ||
    (item.kind === "commit" && item.grammar !== "full-git-sha") ||
    (item.kind === "opaque" && item.grammar !== "opaque-token") ||
    (item.kind === "snapshot" && item.grammar !== "sha256")
  ) return fail(path, "kind and grammar are incompatible");
  return item as unknown as ApprovedSource["revision"];
};

const parseResolver = (
  value: unknown,
  path: string,
  origin: string,
): ApprovedSource["resolver"] => {
  const item = record(value, path);
  exactKeys(item, ["adapter", "version", "entrypoint", "derivedResourcePolicy", "maxBytes"], path);
  const adapter = text(item.adapter, `${path}.adapter`);
  const version = text(item.version, `${path}.version`);
  const derivedResourcePolicy = text(item.derivedResourcePolicy, `${path}.derivedResourcePolicy`);
  const entrypoint = record(item.entrypoint, `${path}.entrypoint`);
  exactKeys(entrypoint, ["sourceId", "url", "mediaType", "maxBytes"], `${path}.entrypoint`);
  const url = httpsUrl(entrypoint.url, `${path}.entrypoint.url`);
  assertSameOrigin(url, origin, `${path}.entrypoint.url`);
  return {
    adapter,
    version,
    entrypoint: {
      sourceId: text(entrypoint.sourceId, `${path}.entrypoint.sourceId`),
      url,
      mediaType: text(entrypoint.mediaType, `${path}.entrypoint.mediaType`),
      maxBytes: integer(entrypoint.maxBytes, `${path}.entrypoint.maxBytes`),
    },
    derivedResourcePolicy,
    maxBytes: integer(item.maxBytes, `${path}.maxBytes`),
  };
};

const parseArtifacts = (
  value: unknown,
  path: string,
  origin: string,
): ApprovedSource["artifacts"] => {
  const item = record(value, path);
  exactKeys(item, ["adapter", "version", "items"], path);
  const adapter = text(item.adapter, `${path}.adapter`);
  const version = text(item.version, `${path}.version`);
  if (!Array.isArray(item.items) || item.items.length > MAX_ARTIFACTS) {
    return fail(`${path}.items`, `must contain at most ${MAX_ARTIFACTS} artifacts`);
  }
  const items = item.items.map((artifact, index) => parseArtifact(artifact, `${path}.items[${index}]`, origin));
  if (new Set(items.map((artifact) => artifact.id)).size !== items.length) return fail(`${path}.items`, "must use unique artifact ids");
  return { adapter, version, items };
};

const parseAttributionAndLicense = (item: Record<string, unknown>, path: string) => {
  const attribution = record(item.attribution, `${path}.attribution`);
  exactKeys(attribution, ["name", "url"], `${path}.attribution`);
  const license = record(item.license, `${path}.license`);
  exactKeys(license, ["identifier", "evidenceUrl"], `${path}.license`);
  return {
    attribution: { name: text(attribution.name, `${path}.attribution.name`), url: httpsUrl(attribution.url, `${path}.attribution.url`) },
    license: {
      identifier: text(license.identifier, `${path}.license.identifier`),
      evidenceUrl: license.evidenceUrl === null ? null : httpsUrl(license.evidenceUrl, `${path}.license.evidenceUrl`),
    },
  };
};

const parseProposalPolicy = (value: unknown, path: string): ApprovedSource["proposalPolicy"] => {
  const item = record(value, path);
  exactKeys(item, ["newRevision", "unknownRows", "mappingChanges"], path);
  for (const key of ["newRevision", "unknownRows", "mappingChanges"] as const) {
    if (item[key] !== "review") return fail(`${path}.${key}`, "must be review");
  }
  return { newRevision: "review", unknownRows: "review", mappingChanges: "review" };
};

const parseSource = (value: unknown, path: string): ApprovedSource => {
  const item = record(value, path);
  exactKeys(item, [
    "id", "owner", "sourceClass", "canonicalOrigin", "attribution", "license",
    "trustRationale", "knownLimitations", "freshness", "revision", "resolver",
    "artifacts", "proposalPolicy",
  ], path);
  if (item.sourceClass !== "external") return fail(`${path}.sourceClass`, "must be external");
  const canonicalOriginUrl = httpsUrl(item.canonicalOrigin, `${path}.canonicalOrigin`);
  const canonicalOrigin = new URL(canonicalOriginUrl).origin;
  if (canonicalOriginUrl !== `${canonicalOrigin}/`) return fail(`${path}.canonicalOrigin`, "must contain only the canonical HTTPS origin");
  if (!Array.isArray(item.knownLimitations) || item.knownLimitations.length > 128) return fail(`${path}.knownLimitations`, "must be a bounded array");
  const resolver = parseResolver(item.resolver, `${path}.resolver`, canonicalOrigin);
  const artifacts = parseArtifacts(item.artifacts, `${path}.artifacts`, canonicalOrigin);
  return {
    id: text(item.id, `${path}.id`), owner: text(item.owner, `${path}.owner`), sourceClass: "external", canonicalOrigin,
    ...parseAttributionAndLicense(item, path),
    trustRationale: text(item.trustRationale, `${path}.trustRationale`),
    knownLimitations: item.knownLimitations.map((entry, index) => text(entry, `${path}.knownLimitations[${index}]`)),
    freshness: parseFreshness(item.freshness, `${path}.freshness`),
    revision: parseRevision(item.revision, `${path}.revision`),
    resolver,
    artifacts,
    proposalPolicy: parseProposalPolicy(item.proposalPolicy, `${path}.proposalPolicy`),
  };
};

const validateRegistry = (registry: ApprovedSourceRegistry): Map<string, string> => {
  if (registry === null || typeof registry !== "object" || !Array.isArray(registry.sources)) {
    return fail("$.registry", "must contain approved source identities");
  }
  if (registry.sources.length === 0 || registry.sources.length > MAX_SOURCES) {
    return fail("$.registry.sources", `must contain between 1 and ${MAX_SOURCES} source identities`);
  }
  const entries = new Map<string, string>();
  registry.sources.forEach((entry, index) => {
    const path = `$.registry.sources[${index}]`;
    const item = record(entry, path);
    exactKeys(item, ["id", "digest"], path);
    const id = text(item.id, `${path}.id`);
    if (typeof item.digest !== "string" || !/^[a-f0-9]{64}$/.test(item.digest)) {
      return fail(`${path}.digest`, "must be a lowercase SHA-256 digest");
    }
    if (entries.has(id)) return fail(`${path}.id`, "must be unique");
    entries.set(id, item.digest);
  });
  return entries;
};

export const parseApprovedSourceManifest = (
  input: string | Uint8Array,
  registry: ApprovedSourceRegistry = DEFAULT_APPROVED_SOURCE_REGISTRY,
): ApprovedSourceManifest => {
  const approvedSources = validateRegistry(registry);
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  if (bytes.byteLength > MAX_MANIFEST_BYTES) return fail("$", `exceeds ${MAX_MANIFEST_BYTES} bytes`);
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (typeof input === "string" && body !== input) return fail("$", "must round-trip through exact UTF-8 bytes");
  } catch {
    return fail("$", "must be valid UTF-8");
  }
  preflightJsonBounds(body);
  const errors: ParseError[] = [];
  let tree: Node | undefined;
  try {
    tree = parseTree(body, errors, { allowTrailingComma: false, disallowComments: true });
  } catch {
    return fail("$", "exceeds the bounded JSON parser capacity");
  }
  if (tree === undefined || errors.length > 0) return fail("$", "must be strict valid JSON");
  assertUniqueObjectKeys(tree);
  const root = record(getNodeValue(tree), "$" );
  exactKeys(root, ["schemaVersion", "sources"], "$" );
  if (root.schemaVersion !== APPROVED_SOURCE_MANIFEST_SCHEMA_VERSION) {
    return fail("$.schemaVersion", `must be ${APPROVED_SOURCE_MANIFEST_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(root.sources) || root.sources.length === 0 || root.sources.length > MAX_SOURCES) {
    return fail("$.sources", `must contain between 1 and ${MAX_SOURCES} approved sources`);
  }
  const sources = root.sources.map((source, index) => parseSource(source, `$.sources[${index}]`));
  if (new Set(sources.map((source) => source.id)).size !== sources.length) {
    return fail("$.sources", "must use unique source ids");
  }
  sources.forEach((source, index) => {
    const approvedDigest = approvedSources.get(source.id);
    if (approvedDigest === undefined || sha256(source) !== approvedDigest) {
      return fail(`$.sources[${index}]`, "must exactly match an approved content-addressed source identity");
    }
  });
  const value = { schemaVersion: APPROVED_SOURCE_MANIFEST_SCHEMA_VERSION, sources };
  const result = deepFreeze({ ...value, digest: sha256(value) });
  parsedManifests.add(result);
  return result;
};

export const isParsedApprovedSourceManifest = (value: unknown): value is ApprovedSourceManifest =>
  value !== null && typeof value === "object" && parsedManifests.has(value);

export const isApprovedRevision = (source: ApprovedSource, revision: string): boolean => {
  if (source.revision.grammar === "calendar-date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(revision)) return false;
    const instant = new Date(`${revision}T00:00:00.000Z`);
    return Number.isFinite(instant.getTime()) && instant.toISOString() === `${revision}T00:00:00.000Z`;
  }
  if (source.revision.grammar === "full-git-sha") return /^[a-f0-9]{40}$/.test(revision);
  if (source.revision.grammar === "sha256") return /^[a-f0-9]{64}$/.test(revision);
  return /^[A-Za-z0-9._-]{1,128}$/.test(revision);
};

export const renderApprovedArtifactUrl = (
  source: ApprovedSource,
  artifact: ApprovedSourceArtifact,
  revision: string,
): string => {
  if (!isApprovedRevision(source, revision)) {
    return fail(`$.sources.${source.id}.revision`, `value does not satisfy ${source.revision.grammar}`);
  }
  let rendered: string;
  if (artifact.urlTemplate.includes("{revision_underscore}")) {
    rendered = artifact.urlTemplate.replace("{revision_underscore}", revision.replaceAll("-", "_"));
  } else {
    rendered = artifact.urlTemplate.replace("{revision}", revision);
  }
  const url = httpsUrl(rendered, `$.sources.${source.id}.artifacts.${artifact.id}.urlTemplate`);
  assertSameOrigin(url, source.canonicalOrigin, `$.sources.${source.id}.artifacts.${artifact.id}.urlTemplate`);
  return url;
};
