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

export interface ApprovedSourceArtifact {
  id: string;
  required: boolean;
  urlTemplate: string;
  mediaType: string;
  maxBytes: number;
}

export interface ApprovedSource {
  id: string;
  owner: string;
  sourceClass: "external";
  canonicalOrigin: string;
  attribution: {
    name: string;
    url: string;
  };
  license: {
    identifier: string;
    evidenceUrl: string | null;
  };
  trustRationale: string;
  knownLimitations: string[];
  freshness: {
    refreshIntervalHours: number;
    maxAgeHours: number;
  };
  revision: {
    kind: "release" | "commit" | "opaque";
    grammar: "calendar-date" | "full-git-sha" | "opaque-token";
  };
  resolver: {
    adapter: string;
    version: string;
    entrypoint: {
      sourceId: string;
      url: string;
      mediaType: string;
      maxBytes: number;
    };
    derivedResourcePolicy: string;
    maxBytes: number;
  };
  artifacts: {
    adapter: string;
    version: string;
    items: ApprovedSourceArtifact[];
  };
  proposalPolicy: {
    newRevision: "review";
    unknownRows: "review";
    mappingChanges: "review";
  };
}

export interface ApprovedSourceManifest {
  schemaVersion: typeof APPROVED_SOURCE_MANIFEST_SCHEMA_VERSION;
  sources: ApprovedSource[];
  digest: string;
}

export interface ApprovedSourceAdapterRegistry {
  resolvers: readonly string[];
  artifacts: readonly string[];
  derivedResourcePolicies: readonly string[];
}

export const DEFAULT_APPROVED_SOURCE_ADAPTER_REGISTRY: ApprovedSourceAdapterRegistry = Object.freeze({
  resolvers: Object.freeze(["livebench-web/v1"]),
  artifacts: Object.freeze(["livebench-release/v1"]),
  derivedResourcePolicies: Object.freeze(["same-origin-livebench-main-bundle/v1"]),
});

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

const parseSource = (
  value: unknown,
  path: string,
  registry: ApprovedSourceAdapterRegistry,
): ApprovedSource => {
  const item = record(value, path);
  exactKeys(item, [
    "id", "owner", "sourceClass", "canonicalOrigin", "attribution", "license",
    "trustRationale", "knownLimitations", "freshness", "revision", "resolver",
    "artifacts", "proposalPolicy",
  ], path);
  if (item.sourceClass !== "external") return fail(`${path}.sourceClass`, "must be external");
  const canonicalOriginUrl = httpsUrl(item.canonicalOrigin, `${path}.canonicalOrigin`);
  const canonicalOrigin = new URL(canonicalOriginUrl).origin;
  if (canonicalOriginUrl !== `${canonicalOrigin}/`) {
    return fail(`${path}.canonicalOrigin`, "must contain only the canonical HTTPS origin");
  }

  const attribution = record(item.attribution, `${path}.attribution`);
  exactKeys(attribution, ["name", "url"], `${path}.attribution`);
  const license = record(item.license, `${path}.license`);
  exactKeys(license, ["identifier", "evidenceUrl"], `${path}.license`);
  const freshness = record(item.freshness, `${path}.freshness`);
  exactKeys(freshness, ["refreshIntervalHours", "maxAgeHours"], `${path}.freshness`);
  const refreshIntervalHours = integer(freshness.refreshIntervalHours, `${path}.freshness.refreshIntervalHours`, 24 * 365);
  const maxAgeHours = integer(freshness.maxAgeHours, `${path}.freshness.maxAgeHours`, 24 * 365 * 10);
  if (maxAgeHours < refreshIntervalHours) {
    return fail(`${path}.freshness.maxAgeHours`, "must be at least refreshIntervalHours");
  }

  const revision = record(item.revision, `${path}.revision`);
  exactKeys(revision, ["kind", "grammar"], `${path}.revision`);
  const revisionKinds = ["release", "commit", "opaque"] as const;
  const revisionGrammars = ["calendar-date", "full-git-sha", "opaque-token"] as const;
  if (!revisionKinds.includes(revision.kind as never)) return fail(`${path}.revision.kind`, "is unsupported");
  if (!revisionGrammars.includes(revision.grammar as never)) return fail(`${path}.revision.grammar`, "is unsupported");
  if (
    (revision.kind === "release" && revision.grammar !== "calendar-date") ||
    (revision.kind === "commit" && revision.grammar !== "full-git-sha") ||
    (revision.kind === "opaque" && revision.grammar !== "opaque-token")
  ) {
    return fail(`${path}.revision`, "kind and grammar are incompatible");
  }

  const resolver = record(item.resolver, `${path}.resolver`);
  exactKeys(resolver, ["adapter", "version", "entrypoint", "derivedResourcePolicy", "maxBytes"], `${path}.resolver`);
  const resolverAdapter = `${text(resolver.adapter, `${path}.resolver.adapter`)}/${text(resolver.version, `${path}.resolver.version`)}`;
  if (!registry.resolvers.includes(resolverAdapter)) return fail(`${path}.resolver`, `unsupported adapter ${resolverAdapter}`);
  const derivedResourcePolicy = text(resolver.derivedResourcePolicy, `${path}.resolver.derivedResourcePolicy`);
  if (!registry.derivedResourcePolicies.includes(derivedResourcePolicy)) {
    return fail(`${path}.resolver.derivedResourcePolicy`, "is unsupported");
  }
  const entrypoint = record(resolver.entrypoint, `${path}.resolver.entrypoint`);
  exactKeys(entrypoint, ["sourceId", "url", "mediaType", "maxBytes"], `${path}.resolver.entrypoint`);
  const entrypointUrl = httpsUrl(entrypoint.url, `${path}.resolver.entrypoint.url`);
  assertSameOrigin(entrypointUrl, canonicalOrigin, `${path}.resolver.entrypoint.url`);

  const artifacts = record(item.artifacts, `${path}.artifacts`);
  exactKeys(artifacts, ["adapter", "version", "items"], `${path}.artifacts`);
  const artifactAdapter = `${text(artifacts.adapter, `${path}.artifacts.adapter`)}/${text(artifacts.version, `${path}.artifacts.version`)}`;
  if (!registry.artifacts.includes(artifactAdapter)) return fail(`${path}.artifacts`, `unsupported adapter ${artifactAdapter}`);
  if (!Array.isArray(artifacts.items) || artifacts.items.length === 0 || artifacts.items.length > MAX_ARTIFACTS) {
    return fail(`${path}.artifacts.items`, `must contain between 1 and ${MAX_ARTIFACTS} artifacts`);
  }
  const parsedArtifacts = artifacts.items.map((artifact, index) => parseArtifact(artifact, `${path}.artifacts.items[${index}]`, canonicalOrigin));
  if (new Set(parsedArtifacts.map((artifact) => artifact.id)).size !== parsedArtifacts.length) {
    return fail(`${path}.artifacts.items`, "must use unique artifact ids");
  }

  const proposalPolicy = record(item.proposalPolicy, `${path}.proposalPolicy`);
  exactKeys(proposalPolicy, ["newRevision", "unknownRows", "mappingChanges"], `${path}.proposalPolicy`);
  for (const key of ["newRevision", "unknownRows", "mappingChanges"] as const) {
    if (proposalPolicy[key] !== "review") return fail(`${path}.proposalPolicy.${key}`, "must be review");
  }

  if (!Array.isArray(item.knownLimitations) || item.knownLimitations.length > 128) {
    return fail(`${path}.knownLimitations`, "must be a bounded array");
  }
  const knownLimitations = item.knownLimitations.map((entry, index) => text(entry, `${path}.knownLimitations[${index}]`));
  const evidenceUrl = license.evidenceUrl === null
    ? null
    : httpsUrl(license.evidenceUrl, `${path}.license.evidenceUrl`);

  return {
    id: text(item.id, `${path}.id`),
    owner: text(item.owner, `${path}.owner`),
    sourceClass: "external",
    canonicalOrigin,
    attribution: {
      name: text(attribution.name, `${path}.attribution.name`),
      url: httpsUrl(attribution.url, `${path}.attribution.url`),
    },
    license: {
      identifier: text(license.identifier, `${path}.license.identifier`),
      evidenceUrl,
    },
    trustRationale: text(item.trustRationale, `${path}.trustRationale`),
    knownLimitations,
    freshness: { refreshIntervalHours, maxAgeHours },
    revision: revision as ApprovedSource["revision"],
    resolver: {
      adapter: text(resolver.adapter, `${path}.resolver.adapter`),
      version: text(resolver.version, `${path}.resolver.version`),
      entrypoint: {
        sourceId: text(entrypoint.sourceId, `${path}.resolver.entrypoint.sourceId`),
        url: entrypointUrl,
        mediaType: text(entrypoint.mediaType, `${path}.resolver.entrypoint.mediaType`),
        maxBytes: integer(entrypoint.maxBytes, `${path}.resolver.entrypoint.maxBytes`),
      },
      derivedResourcePolicy,
      maxBytes: integer(resolver.maxBytes, `${path}.resolver.maxBytes`),
    },
    artifacts: {
      adapter: text(artifacts.adapter, `${path}.artifacts.adapter`),
      version: text(artifacts.version, `${path}.artifacts.version`),
      items: parsedArtifacts,
    },
    proposalPolicy: { newRevision: "review", unknownRows: "review", mappingChanges: "review" },
  };
};

export const parseApprovedSourceManifest = (
  input: string | Uint8Array,
  registry: ApprovedSourceAdapterRegistry = DEFAULT_APPROVED_SOURCE_ADAPTER_REGISTRY,
): ApprovedSourceManifest => {
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
  const sources = root.sources.map((source, index) => parseSource(source, `$.sources[${index}]`, registry));
  if (new Set(sources.map((source) => source.id)).size !== sources.length) {
    return fail("$.sources", "must use unique source ids");
  }
  const value = { schemaVersion: APPROVED_SOURCE_MANIFEST_SCHEMA_VERSION, sources };
  return deepFreeze({ ...value, digest: sha256(value) });
};

export const isApprovedRevision = (source: ApprovedSource, revision: string): boolean => {
  if (source.revision.grammar === "calendar-date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(revision)) return false;
    const instant = new Date(`${revision}T00:00:00.000Z`);
    return Number.isFinite(instant.getTime()) && instant.toISOString() === `${revision}T00:00:00.000Z`;
  }
  if (source.revision.grammar === "full-git-sha") return /^[a-f0-9]{40}$/.test(revision);
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
