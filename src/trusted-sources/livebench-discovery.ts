import {
  buildSnapshotSourceRef,
  parseSnapshotSourceRef,
  type SnapshotSourceRefResolution,
} from "@kontourai/forage/fetch";

import { compareText, sha256 } from "../canonical.js";
import { BearingError } from "../error.js";
import {
  renderApprovedArtifactUrl,
  type ApprovedSource,
  type ApprovedSourceManifest,
} from "./manifest.js";

const MAX_SOURCE_REF_LENGTH = 16 * 1024;
const BUNDLE_PATH_PATTERN = /^\/static\/js\/main\.[a-f0-9]{8}\.js$/;
const RELEASE_ARRAY_PATTERN = /\[(?:"\d{4}-\d{2}-\d{2}")(?:,"\d{4}-\d{2}-\d{2}")+\]/g;
const RELEASE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RELEASES = 1_000;

export const LIVEBENCH_DISCOVERY_SCHEMA_VERSION = "bearing.source-revision-proposal/v1" as const;

export type TrustedDiscoverySnapshot = Extract<SnapshotSourceRefResolution, { ok: true }>;

export interface LiveBenchBundleLocator {
  sourceId: string;
  url: string;
  mediaType: "application/javascript";
  maxBytes: number;
}

export interface LiveBenchBundleDiscovery {
  sourceId: string;
  manifestDigest: string;
  resolver: { adapter: "livebench-web"; version: "v1" };
  entrypoint: SourceAcquisition;
  bundle: LiveBenchBundleLocator;
}

export interface LiveBenchRevisionProposal {
  schemaVersion: typeof LIVEBENCH_DISCOVERY_SCHEMA_VERSION;
  id: string;
  sourceId: string;
  manifestDigest: string;
  resolver: { adapter: "livebench-web"; version: "v1" };
  entrypoint: SourceAcquisition;
  bundle: SourceAcquisition;
  revisions: string[];
  currentRevision: string;
  artifacts: Array<{
    id: string;
    required: boolean;
    sourceId: string;
    url: string;
    mediaType: string;
    maxBytes: number;
  }>;
}

interface SourceAcquisition {
  sourceId: string;
  sourceRef: string;
  url: string;
  bodySha256: string;
  fetchedAt: string;
}

interface ValidatedSnapshot {
  body: string;
  acquisition: SourceAcquisition;
}

const fail = (path: string, message: string): never => {
  throw new BearingError("INVALID_SOURCE_DISCOVERY", path, message);
};

const sourceFromManifest = (manifest: ApprovedSourceManifest, sourceId: string): ApprovedSource => {
  if (sha256({ schemaVersion: manifest.schemaVersion, sources: manifest.sources }) !== manifest.digest) {
    return fail("$.manifest", "digest does not match the supplied approved source manifest");
  }
  const source = manifest.sources.find((candidate) => candidate.id === sourceId);
  if (source === undefined) return fail("$.sourceId", "must identify an approved manifest source");
  if (
    source.resolver.adapter !== "livebench-web" || source.resolver.version !== "v1" ||
    source.resolver.derivedResourcePolicy !== "same-origin-livebench-main-bundle/v1"
  ) {
    return fail("$.sourceId", "must use the supported LiveBench resolver contract");
  }
  return source;
};

const decodeBody = (body: string | Uint8Array, path: string): string => {
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (typeof body === "string" && decoded !== body) {
      return fail(path, "must round-trip through exact UTF-8 bytes");
    }
    return decoded;
  } catch {
    return fail(path, "must be valid UTF-8");
  }
};

const validateSnapshot = (
  resolution: TrustedDiscoverySnapshot,
  expected: { sourceId: string; url: string; maxBytes: number; mediaType: string },
  path: string,
): ValidatedSnapshot => {
  if (resolution === null || typeof resolution !== "object" || resolution.ok !== true) {
    return fail(path, "must be a successful exact snapshot resolution");
  }
  if (resolution.integrity !== "snapshot-envelope") {
    return fail(`${path}.integrity`, "must cite a full snapshot envelope");
  }
  let sourceRef: string;
  try {
    sourceRef = buildSnapshotSourceRef(resolution.snapshot);
  } catch {
    return fail(path, "must contain a valid canonical durable snapshot");
  }
  if (sourceRef.length > MAX_SOURCE_REF_LENGTH) {
    return fail(`${path}.reference`, `must encode within ${MAX_SOURCE_REF_LENGTH} characters`);
  }
  const canonicalReference = parseSnapshotSourceRef(sourceRef)!;
  if (
    resolution.reference.sourceId !== canonicalReference.sourceId ||
    resolution.reference.url !== canonicalReference.url ||
    resolution.reference.bodyHash !== canonicalReference.bodyHash ||
    resolution.reference.fetchedAt !== canonicalReference.fetchedAt ||
    resolution.reference.snapshotDigest !== canonicalReference.snapshotDigest
  ) {
    return fail(`${path}.reference`, "must exactly match the recomputed snapshot envelope");
  }
  if (
    resolution.snapshot.sourceId !== expected.sourceId ||
    resolution.snapshot.url !== expected.url ||
    resolution.snapshot.status !== 200
  ) {
    return fail(path, "must bind the approved source identity, URL, and a successful response");
  }
  const bytes = typeof resolution.snapshot.body === "string"
    ? Buffer.from(resolution.snapshot.body, "utf8")
    : resolution.snapshot.body;
  if (bytes.byteLength > expected.maxBytes) return fail(`${path}.body`, `exceeds ${expected.maxBytes} bytes`);
  const fetchedAt = new Date(resolution.snapshot.fetchedAt);
  if (!Number.isFinite(fetchedAt.getTime()) || fetchedAt.toISOString() !== resolution.snapshot.fetchedAt) {
    return fail(`${path}.fetchedAt`, "must be an ISO-8601 UTC timestamp");
  }
  const contentType = Object.entries(resolution.snapshot.headers ?? {})
    .find(([name]) => name.toLowerCase() === "content-type")?.[1]
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== expected.mediaType.toLowerCase()) {
    return fail(`${path}.headers.content-type`, `must be ${expected.mediaType}`);
  }
  return {
    body: decodeBody(resolution.snapshot.body, `${path}.body`),
    acquisition: {
      sourceId: resolution.snapshot.sourceId,
      sourceRef,
      url: resolution.snapshot.url,
      bodySha256: resolution.snapshot.bodyHash,
      fetchedAt: resolution.snapshot.fetchedAt,
    },
  };
};

const findBundleUrl = (body: string, source: ApprovedSource): string => {
  const candidates = new Set<string>();
  const scriptPattern = /<script\b([^>]*)>/giu;
  for (const script of body.matchAll(scriptPattern)) {
    const attributes = script[1];
    const sourceAttribute = /(?:^|\s)src\s*=\s*(["'])(.*?)\1/iu.exec(attributes);
    if (sourceAttribute === null) continue;
    let candidate: URL;
    try {
      candidate = new URL(sourceAttribute[2], source.resolver.entrypoint.url);
    } catch {
      continue;
    }
    if (
      candidate.origin === source.canonicalOrigin &&
      candidate.username === "" && candidate.password === "" && candidate.hash === "" &&
      BUNDLE_PATH_PATTERN.test(candidate.pathname) && candidate.search === ""
    ) {
      candidates.add(candidate.href);
    }
  }
  if (candidates.size !== 1) {
    return fail("$.indexSnapshot.body", "must advertise exactly one approved same-origin LiveBench main bundle");
  }
  return [...candidates][0];
};

const validRelease = (value: string): boolean => {
  if (!RELEASE_PATTERN.test(value)) return false;
  const instant = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(instant.getTime()) && instant.toISOString() === `${value}T00:00:00.000Z`;
};

const findReleases = (body: string): string[] => {
  const candidates = [...body.matchAll(RELEASE_ARRAY_PATTERN)];
  if (candidates.length !== 1) {
    return fail("$.bundleSnapshot.body", "must contain exactly one bounded LiveBench release-date array");
  }
  if (candidates[0][0].length > MAX_RELEASES * 13 + 2) {
    return fail("$.bundleSnapshot.body", `exceeds the maximum release count of ${MAX_RELEASES}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidates[0][0]);
  } catch {
    return fail("$.bundleSnapshot.body", "contains an invalid release-date array");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_RELEASES) {
    return fail("$.bundleSnapshot.body", `must contain between 1 and ${MAX_RELEASES} releases`);
  }
  const releases = parsed.map((value, index) =>
    typeof value === "string" && validRelease(value)
      ? value
      : fail(`$.bundleSnapshot.body.releases[${index}]`, "must be a real calendar date"));
  const sorted = [...new Set(releases)].sort(compareText);
  if (sorted.length !== releases.length || JSON.stringify(sorted) !== JSON.stringify(releases)) {
    return fail("$.bundleSnapshot.body", "release dates must be unique and ascending");
  }
  return releases;
};

export const liveBenchBundleSourceId = (url: string): string =>
  `livebench-bundle-${sha256({ url }).slice(0, 24)}`;

export const discoverLiveBenchBundle = (input: {
  manifest: ApprovedSourceManifest;
  sourceId: string;
  indexSnapshot: TrustedDiscoverySnapshot;
}): LiveBenchBundleDiscovery => {
  const source = sourceFromManifest(input.manifest, input.sourceId);
  const index = validateSnapshot(input.indexSnapshot, source.resolver.entrypoint, "$.indexSnapshot");
  const bundleUrl = findBundleUrl(index.body, source);
  return {
    sourceId: source.id,
    manifestDigest: input.manifest.digest,
    resolver: { adapter: "livebench-web", version: "v1" },
    entrypoint: index.acquisition,
    bundle: {
      sourceId: liveBenchBundleSourceId(bundleUrl),
      url: bundleUrl,
      mediaType: "application/javascript",
      maxBytes: source.resolver.maxBytes,
    },
  };
};

export const resolveLiveBenchDiscovery = (input: {
  manifest: ApprovedSourceManifest;
  sourceId: string;
  indexSnapshot: TrustedDiscoverySnapshot;
  bundleSnapshot: TrustedDiscoverySnapshot;
}): LiveBenchRevisionProposal => {
  const source = sourceFromManifest(input.manifest, input.sourceId);
  const discovery = discoverLiveBenchBundle(input);
  const bundle = validateSnapshot(input.bundleSnapshot, discovery.bundle, "$.bundleSnapshot");
  const revisions = findReleases(bundle.body);
  const currentRevision = revisions.at(-1)!;
  const artifacts = source.artifacts.items.map((artifact) => ({
    id: artifact.id,
    required: artifact.required,
    sourceId: `${source.id}-${currentRevision}-${artifact.id}`,
    url: renderApprovedArtifactUrl(source, artifact, currentRevision),
    mediaType: artifact.mediaType,
    maxBytes: artifact.maxBytes,
  }));
  const proposal = {
    schemaVersion: LIVEBENCH_DISCOVERY_SCHEMA_VERSION,
    sourceId: source.id,
    manifestDigest: input.manifest.digest,
    resolver: discovery.resolver,
    entrypoint: discovery.entrypoint,
    bundle: bundle.acquisition,
    revisions,
    currentRevision,
    artifacts,
  };
  return { ...proposal, id: sha256(proposal) };
};
