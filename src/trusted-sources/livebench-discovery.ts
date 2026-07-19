import {
  buildSnapshotSourceRef,
  parseSnapshotSourceRef,
  type SnapshotSourceRefResolution,
} from "@kontourai/forage/fetch";
import { parse as parseJavaScript } from "acorn";
import { parse as parseHtml } from "parse5";

import { compareText, sha256 } from "../canonical.js";
import { BearingError } from "../error.js";
import {
  isDefaultApprovedSourceIdentity,
  renderApprovedArtifactUrl,
  isParsedApprovedSourceManifest,
  type ApprovedSource,
  type ApprovedSourceManifest,
} from "./manifest.js";

const MAX_SOURCE_REF_LENGTH = 16 * 1024;
const BUNDLE_PATH_PATTERN = /^\/static\/js\/main\.[a-f0-9]{8}\.js$/;
const RELEASE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RELEASES = 1_000;
const REVIEWED_RELEASE_PREFIX = Object.freeze(["2024-06-24", "2024-07-26", "2024-08-31"]);

export const LIVEBENCH_DISCOVERY_SCHEMA_VERSION = "bearing.source-revision-proposal/v1" as const;

export type TrustedDiscoverySnapshot = Extract<SnapshotSourceRefResolution, { ok: true }>;

export interface LiveBenchBundleLocator {
  readonly sourceId: string;
  readonly url: string;
  readonly mediaType: "application/javascript";
  readonly maxBytes: number;
}

export interface LiveBenchBundleDiscovery {
  readonly sourceId: string;
  readonly manifestDigest: string;
  readonly resolver: { readonly adapter: "livebench-web"; readonly version: "v1" };
  readonly entrypoint: SourceAcquisition;
  readonly bundle: LiveBenchBundleLocator;
}

export interface LiveBenchRevisionProposal {
  readonly schemaVersion: typeof LIVEBENCH_DISCOVERY_SCHEMA_VERSION;
  readonly id: string;
  readonly sourceId: string;
  readonly manifestDigest: string;
  readonly resolver: { readonly adapter: "livebench-web"; readonly version: "v1" };
  readonly entrypoint: SourceAcquisition;
  readonly bundle: SourceAcquisition;
  readonly revisions: readonly string[];
  readonly currentRevision: string;
  readonly artifacts: ReadonlyArray<{
    readonly id: string;
    readonly required: boolean;
    readonly sourceId: string;
    readonly url: string;
    readonly mediaType: string;
    readonly maxBytes: number;
  }>;
}

interface SourceAcquisition {
  readonly sourceId: string;
  readonly sourceRef: string;
  readonly url: string;
  readonly bodySha256: string;
  readonly fetchedAt: string;
}

interface ValidatedSnapshot {
  body: string;
  acquisition: SourceAcquisition;
}

const fail = (path: string, message: string): never => {
  throw new BearingError("INVALID_SOURCE_DISCOVERY", path, message);
};

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
};

const sourceFromManifest = (manifest: ApprovedSourceManifest, sourceId: string): ApprovedSource => {
  if (!isParsedApprovedSourceManifest(manifest)) {
    return fail("$.manifest", "must be a parsed approved source manifest");
  }
  if (sha256({ schemaVersion: manifest.schemaVersion, sources: manifest.sources }) !== manifest.digest) {
    return fail("$.manifest", "digest does not match the supplied approved source manifest");
  }
  const source = manifest.sources.find((candidate) => candidate.id === sourceId);
  if (source === undefined) return fail("$.sourceId", "must identify an approved manifest source");
  if (sourceId !== "livebench" || !isDefaultApprovedSourceIdentity(source)) {
    return fail("$.sourceId", "must use the approved official LiveBench source identity");
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
    resolution.reference === null || typeof resolution.reference !== "object" ||
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

interface HtmlNode {
  nodeName?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: HtmlNode[];
  content?: HtmlNode;
}

const findBundleUrl = (body: string, source: ApprovedSource): string => {
  const candidates = new Set<string>();
  let document: HtmlNode;
  try {
    document = parseHtml(body) as unknown as HtmlNode;
  } catch {
    return fail("$.indexSnapshot.body", "must be parseable HTML");
  }
  const pending: HtmlNode[] = [document];
  while (pending.length > 0) {
    const node = pending.pop()!;
    pending.push(...(node.childNodes ?? []));
    if (node.nodeName !== "script") continue;
    const type = node.attrs?.find((attribute) => attribute.name === "type")?.value.trim().toLowerCase();
    if (type !== undefined && !["module", "text/javascript", "application/javascript"].includes(type)) continue;
    const sourceAttribute = node.attrs?.find((attribute) => attribute.name === "src")?.value;
    if (sourceAttribute === undefined) continue;
    let candidate: URL;
    try {
      candidate = new URL(sourceAttribute, source.resolver.entrypoint.url);
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

interface JavaScriptNode {
  type: string;
  [key: string]: unknown;
}

const childNodes = (node: JavaScriptNode): JavaScriptNode[] => Object.entries(node)
  .filter(([key]) => key !== "start" && key !== "end" && key !== "loc")
  .flatMap(([, value]) => Array.isArray(value) ? value : [value])
  .filter((value): value is JavaScriptNode => value !== null && typeof value === "object" && typeof (value as JavaScriptNode).type === "string");

const releasesFromArray = (node: JavaScriptNode): string[] | null => {
  if (node.type !== "ArrayExpression" || !Array.isArray(node.elements)) return null;
  const releases = node.elements.map((element) => {
    const item = element as JavaScriptNode | null;
    return item?.type === "Literal" && typeof item.value === "string" && validRelease(item.value) ? item.value : null;
  });
  if (releases.some((release) => release === null)) return null;
  const values = releases as string[];
  return values.length >= REVIEWED_RELEASE_PREFIX.length &&
    REVIEWED_RELEASE_PREFIX.every((release, index) => values[index] === release) ? values : null;
};

const isIdentifier = (value: unknown, name: string): boolean => {
  const node = value as JavaScriptNode | null;
  return node?.type === "Identifier" && node.name === name;
};

const isLatestExpression = (value: unknown, releasesName: string): boolean => {
  const node = value as JavaScriptNode | null;
  const left = node?.type === "MemberExpression" ? node.property as JavaScriptNode | null : null;
  return node?.type === "MemberExpression" && node.computed === true && isIdentifier(node.object, releasesName) &&
    left?.type === "BinaryExpression" && left.operator === "-" &&
    (left.right as JavaScriptNode | undefined)?.type === "Literal" && (left.right as JavaScriptNode).value === 1 &&
    (left.left as JavaScriptNode | undefined)?.type === "MemberExpression" && (left.left as JavaScriptNode).computed === false &&
    isIdentifier((left.left as JavaScriptNode).object, releasesName) && isIdentifier((left.left as JavaScriptNode).property, "length");
};

const reachableStatements = (scope: JavaScriptNode): JavaScriptNode[] => {
  const result: JavaScriptNode[] = [];
  for (const statement of scope.body as JavaScriptNode[] | undefined ?? []) {
    result.push(statement);
    if (statement.type === "ReturnStatement" || statement.type === "ThrowStatement") break;
  }
  return result;
};

const directDeclarators = (statements: JavaScriptNode[]): JavaScriptNode[] => statements
  .filter((statement) => statement.type === "VariableDeclaration")
  .flatMap((statement) => statement.declarations as JavaScriptNode[] | undefined ?? []);

const STRAIGHT_LINE_NODE_TYPES = new Set([
  "ArrayExpression", "AssignmentExpression", "AssignmentPattern", "AwaitExpression", "BinaryExpression", "CallExpression",
  "ExpressionStatement", "Identifier", "Literal", "MemberExpression", "NewExpression", "ObjectExpression",
  "Property", "RestElement", "ReturnStatement", "SequenceExpression", "SpreadElement", "Super",
  "TaggedTemplateExpression", "TemplateElement", "TemplateLiteral", "ThisExpression", "UnaryExpression",
  "UpdateExpression", "VariableDeclaration", "VariableDeclarator", "YieldExpression",
]);

const straightLineSome = (root: JavaScriptNode, predicate: (node: JavaScriptNode) => boolean): boolean => {
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (!STRAIGHT_LINE_NODE_TYPES.has(node.type)) continue;
    if ((node.type === "CallExpression" || node.type === "MemberExpression") && node.optional === true) continue;
    if (predicate(node)) return true;
    pending.push(...childNodes(node));
  }
  return false;
};

const currentScopeSome = (root: JavaScriptNode, predicate: (node: JavaScriptNode) => boolean): boolean => {
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (predicate(node)) return true;
    if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ClassDeclaration", "ClassExpression"].includes(node.type)) continue;
    pending.push(...childNodes(node));
  }
  return false;
};

const allDescendantsSome = (root: JavaScriptNode, predicate: (node: JavaScriptNode) => boolean): boolean => {
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (predicate(node)) return true;
    pending.push(...childNodes(node));
  }
  return false;
};

const bindingNames = (value: unknown): string[] => {
  const node = value as JavaScriptNode | null;
  if (node === null || typeof node !== "object") return [];
  if (node.type === "Identifier") return [node.name as string];
  return childNodes(node).flatMap(bindingNames);
};

const assignmentTargetNames = (value: unknown): string[] => {
  const node = value as JavaScriptNode | null;
  if (node === null || typeof node !== "object") return [];
  if (node.type === "Identifier") return [node.name as string];
  if (node.type === "MemberExpression") return [];
  if (node.type === "Property") return assignmentTargetNames(node.value);
  if (["ArrayPattern", "ObjectPattern", "RestElement", "AssignmentPattern"].includes(node.type)) {
    return childNodes(node).flatMap(assignmentTargetNames);
  }
  return [];
};

const writesAnyBinding = (statements: JavaScriptNode[], names: readonly string[]): boolean => statements.some((statement) =>
  allDescendantsSome(statement, (node) => {
    const targets = node.type === "AssignmentExpression"
      ? assignmentTargetNames(node.left)
      : node.type === "UpdateExpression"
        ? assignmentTargetNames(node.argument)
        : [];
    return targets.some((target) => names.includes(target));
  }));

const nestedFunctionVarBindingNames = (component: JavaScriptNode): string[] => {
  const body = component.body as JavaScriptNode;
  const pending = childNodes(body);
  const names: string[] = [];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ClassDeclaration", "ClassExpression"].includes(node.type)) continue;
    if (node.type === "VariableDeclaration" && node.kind === "var") {
      names.push(...(node.declarations as JavaScriptNode[] | undefined ?? []).flatMap((item) => bindingNames(item.id)));
    }
    pending.push(...childNodes(node));
  }
  return names;
};

const directBindingNames = (statements: JavaScriptNode[]): string[] => statements.flatMap((statement) => {
  if (statement.type === "VariableDeclaration") {
    return (statement.declarations as JavaScriptNode[] | undefined ?? []).flatMap((item) => bindingNames(item.id));
  }
  if (statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") {
    return bindingNames(statement.id);
  }
  return [];
});

const componentUsesReleaseSemantics = (component: JavaScriptNode, releasesName: string, latestName: string): boolean => {
  if ((component.params as unknown[] | undefined ?? []).length !== 0) return false;
  const statements = reachableStatements(component.body as JavaScriptNode);
  const shadows = [...directBindingNames(statements), ...nestedFunctionVarBindingNames(component)];
  if (shadows.includes(releasesName) || shadows.includes(latestName) || writesAnyBinding(statements, [releasesName, latestName])) return false;
  const releasesProperty = statements.some((statement) => straightLineSome(statement, (node) =>
    node.type === "Property" && isIdentifier(node.key, "releases") && isIdentifier(node.value, releasesName)));
  const latestArgument = statements.some((statement) => straightLineSome(statement, (node) =>
    node.type === "CallExpression" && (node.arguments as unknown[] | undefined ?? []).some((argument) => isIdentifier(argument, latestName))));
  return releasesProperty && latestArgument;
};

const componentIsReferenced = (statements: JavaScriptNode[], component: JavaScriptNode): boolean => {
  const name = (component.id as JavaScriptNode).name as string;
  const otherStatements = statements.filter((statement) => statement !== component);
  if (directBindingNames(otherStatements).includes(name) || writesAnyBinding(otherStatements, [name])) return false;
  return otherStatements.some((statement) => straightLineSome(statement, (node) =>
    node.type === "CallExpression" && (node.arguments as unknown[] | undefined ?? []).some((argument) => isIdentifier(argument, name))));
};

const scopeBindsReleaseSemantics = (scope: JavaScriptNode, releasesName: string): boolean => {
  const statements = reachableStatements(scope);
  if (statements.some((statement) => currentScopeSome(statement, (node) =>
    node !== statement && (node.type === "ReturnStatement" || node.type === "ThrowStatement")))) return false;
  const declarators = directDeclarators(statements);
  const releasesIndex = declarators.findIndex((item) =>
    isIdentifier(item.id, releasesName) && (item.init as JavaScriptNode | undefined)?.type === "ArrayExpression" &&
    releasesFromArray(item.init as JavaScriptNode) !== null);
  const latestIndex = declarators.findIndex((item) =>
    (item.id as JavaScriptNode | undefined)?.type === "Identifier" && isLatestExpression(item.init, releasesName));
  if (releasesIndex < 0 || latestIndex <= releasesIndex) return false;
  const latest = declarators[latestIndex];
  const latestName = (latest.id as JavaScriptNode).name as string;
  if (writesAnyBinding(statements, [releasesName, latestName])) return false;
  const components = statements.filter((statement) =>
    statement.type === "FunctionDeclaration" && (statement.id as JavaScriptNode | undefined)?.type === "Identifier");
  return components.some((component) =>
    componentUsesReleaseSemantics(component, releasesName, latestName) && componentIsReferenced(statements, component));
};

const CANDIDATE_ANCESTOR_TYPES = new Set([
  "Program", "ExpressionStatement", "CallExpression", "ArrowFunctionExpression", "FunctionExpression",
  "BlockStatement", "SequenceExpression", "VariableDeclaration", "VariableDeclarator",
]);

const hasUnconditionalCandidateAncestry = (ancestors: JavaScriptNode[]): boolean => ancestors.every((ancestor, index) => {
  if (!CANDIDATE_ANCESTOR_TYPES.has(ancestor.type)) return false;
  if (ancestor.type !== "ArrowFunctionExpression" && ancestor.type !== "FunctionExpression") return true;
  const parent = ancestors[index - 1];
  return parent?.type === "CallExpression" && parent.optional !== true && parent.callee === ancestor;
});

const activeFunctionScope = (ancestors: JavaScriptNode[]): JavaScriptNode | null => {
  if (!hasUnconditionalCandidateAncestry(ancestors)) return null;
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    if (ancestors[index].type !== "BlockStatement") continue;
    const parentType = ancestors[index - 1]?.type;
    if (parentType !== "ArrowFunctionExpression" && parentType !== "FunctionExpression" && parentType !== "FunctionDeclaration") return null;
    return ancestors[index];
  }
  return null;
};

const findReleases = (body: string): string[] => {
  let program: JavaScriptNode;
  try {
    program = parseJavaScript(body, { ecmaVersion: "latest", sourceType: "script" }) as unknown as JavaScriptNode;
  } catch {
    return fail("$.bundleSnapshot.body", "must be valid JavaScript");
  }
  const candidates: string[][] = [];
  const pending: Array<{ node: JavaScriptNode; ancestors: JavaScriptNode[] }> = [{ node: program, ancestors: [] }];
  while (pending.length > 0) {
    const { node, ancestors } = pending.pop()!;
    const declaration = ancestors.at(-2);
    const declarator = ancestors.at(-1);
    const releases = releasesFromArray(node);
    if (
      releases !== null && declaration?.type === "VariableDeclaration" && declaration.kind === "const" &&
      declarator?.type === "VariableDeclarator" && declarator.init === node &&
      (declarator.id as JavaScriptNode | undefined)?.type === "Identifier"
    ) {
      const name = (declarator.id as JavaScriptNode).name as string;
      const scope = activeFunctionScope(ancestors);
      const statements = scope === null ? undefined : reachableStatements(scope);
      const declarationIndex = statements?.indexOf(declaration) ?? -1;
      if (scope !== null && declarationIndex >= 0 && scopeBindsReleaseSemantics(scope, name)) candidates.push(releases);
    }
    for (const child of childNodes(node)) pending.push({ node: child, ancestors: [...ancestors, node] });
  }
  if (candidates.length !== 1) {
    return fail("$.bundleSnapshot.body", "must contain exactly one LiveBench release array with the reviewed lineage");
  }
  const parsed = candidates[0];
  if (parsed.length > MAX_RELEASES) {
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
  return deepFreeze({ ...proposal, id: sha256(proposal) });
};
