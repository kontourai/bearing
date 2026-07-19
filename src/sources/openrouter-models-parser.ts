import { getNodeValue, parseTree, type Node, type ParseError } from "jsonc-parser";

import { compareText } from "../canonical.js";
import { BearingError } from "../error.js";

export const OPENROUTER_MAX_ROWS = 5_000;

const MAX_TEXT_CHARACTERS = 32_768;
const MAX_ARRAY_ITEMS = 1_000;
const MAX_MODEL_ID_CHARACTERS = 512;
const MAX_DESIGN_CATEGORY_CHARACTERS = 256;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_STRUCTURAL_TOKENS = 100_000;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/;
const REASONING_EFFORTS = new Set(["max", "xhigh", "high", "medium", "low", "minimal", "none"]);
const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export interface ParsedOpenRouterModelRow {
  id: string;
  contextLength: number;
  topProviderContextLength: number | null;
  maxCompletionTokens: number | null;
  promptPrice: number | null;
  completionPrice: number | null;
  inputModalities: string[];
  supportedParameters: string[];
  reasoning: {
    mandatory: boolean;
    defaultEnabled: boolean | null;
    supportedEfforts: string[];
  } | null;
  artificialAnalysis: {
    intelligence: number | null;
    coding: number | null;
    agentic: number | null;
  } | null;
  designArena: Array<{
    arena: "agents" | "models";
    category: string;
    elo: number;
    winRate: number;
    rank: number;
  }>;
}

const fail = (path: string, message: string): never => {
  throw new BearingError("INVALID_SOURCE_SNAPSHOT", path, message);
};

const record = (value: unknown, path: string): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : fail(path, "must be an object");

const exactKeys = (value: Record<string, unknown>, keys: readonly string[], path: string): void => {
  const actual = Object.keys(value).sort(compareText);
  const expected = [...keys].sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    return fail(path, `must contain exactly: ${expected.join(", ")}`);
  }
};

const allowedKeys = (value: Record<string, unknown>, keys: readonly string[], path: string): void => {
  const unexpected = Object.keys(value).filter((key) => !keys.includes(key)).sort(compareText);
  if (unexpected.length > 0) return fail(path, `contains unsupported fields: ${unexpected.join(", ")}`);
};

const requiredKeys = (value: Record<string, unknown>, keys: readonly string[], path: string): void => {
  const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length > 0) return fail(path, `is missing required fields: ${missing.join(", ")}`);
};

const text = (value: unknown, path: string): string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT_CHARACTERS && value.trim() === value
    ? value
    : fail(path, `must be a trimmed non-empty string of at most ${MAX_TEXT_CHARACTERS} characters`);

const identityText = (value: unknown, path: string, maxCharacters: number): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > maxCharacters || value.trim() !== value) {
    return fail(path, `must be a trimmed non-empty identity of at most ${maxCharacters} characters`);
  }
  try { encodeURIComponent(value); } catch { return fail(path, "must be URI-encodable Unicode text"); }
  return value;
};

const positiveInteger = (value: unknown, path: string): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : fail(path, "must be a positive safe integer");

const optionalPositiveInteger = (value: unknown, path: string): number | null =>
  value === null ? null : positiveInteger(value, path);

const boundedNumber = (value: unknown, path: string): number | null => {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    return fail(path, "must be null or a finite number between 0 and 100");
  }
  return value;
};

const numberBetween = (value: unknown, minimum: number, maximum: number, path: string): number =>
  typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : fail(path, `must be a finite number between ${minimum} and ${maximum}`);

const decimal = (value: unknown, path: string): number => {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) return fail(path, "must be a non-negative finite decimal string");
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return fail(path, "must be a fixed-point USD/token decimal between 0 and 1 with at most 12 fractional digits");
  }
  return parsed;
};

const availableDecimal = (value: unknown, path: string): number | null =>
  value === "-1" ? null : decimal(value, path);

const validateSourceDecimal = (value: unknown, path: string): void => {
  if (value === "-1") return;
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d{1,32})?$/.test(value)) {
    return fail(path, "must be an unavailable sentinel or bounded fixed-point decimal string");
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return fail(path, "must encode a fixed-point decimal between 0 and 1");
};

const textArray = (value: unknown, path: string): string[] => {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) return fail(path, "must be a bounded string array");
  const items = value.map((item, index) => text(item, `${path}[${index}]`));
  if (new Set(items).size !== items.length) return fail(path, "must not contain duplicates");
  return items.sort(compareText);
};

const nullableText = (value: unknown, path: string): string | null =>
  value === null ? null : text(value, path);

const boundedSourceText = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.length > MAX_TEXT_CHARACTERS) {
    return fail(path, `must be a string of at most ${MAX_TEXT_CHARACTERS} characters`);
  }
  return value;
};

const nullableBoundedText = (value: unknown, path: string): string | null =>
  value === null ? null : boundedSourceText(value, path);

const finiteNumberOrNull = (value: unknown, path: string): number | null => {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return fail(path, "must be null or a finite number");
  return value;
};

const validateDefaultParameters = (value: unknown, path: string): void => {
  const item = record(value, path);
  allowedKeys(item, ["frequency_penalty", "presence_penalty", "repetition_penalty", "temperature", "top_k", "top_p"], path);
  for (const [key, parameter] of Object.entries(item)) finiteNumberOrNull(parameter, `${path}.${key}`);
};

const validatePricingOverrides = (value: unknown, path: string): void => {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) return fail(path, "must be null or a bounded array");
  value.forEach((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const item = record(entry, itemPath);
    allowedKeys(item, ["min_prompt_tokens", "prompt", "completion", "audio", "input_audio_cache", "input_cache_read", "input_cache_write", "input_cache_write_1h"], itemPath);
    requiredKeys(item, ["min_prompt_tokens", "prompt", "completion"], itemPath);
    positiveInteger(item.min_prompt_tokens, `${itemPath}.min_prompt_tokens`);
    for (const [key, price] of Object.entries(item)) {
      if (key !== "min_prompt_tokens") validateSourceDecimal(price, `${itemPath}.${key}`);
    }
  });
};

const validatePricingExtras = (pricing: Record<string, unknown>, path: string): void => {
  const priceKeys = [
    "image", "audio", "web_search", "internal_reasoning", "input_cache_read", "input_cache_write",
    "input_cache_write_1h", "input_audio_cache", "image_output", "audio_output",
  ];
  for (const key of priceKeys) {
    if (pricing[key] !== undefined && pricing[key] !== null) validateSourceDecimal(pricing[key], `${path}.${key}`);
  }
  validatePricingOverrides(pricing.overrides, `${path}.overrides`);
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
      if (depth > MAX_JSON_DEPTH) return fail("$.snapshot.body", `exceeds maximum JSON depth ${MAX_JSON_DEPTH}`);
    } else if (character === "}" || character === "]") {
      depth -= 1;
      structuralTokens += 1;
    } else if (character === "," || character === ":") structuralTokens += 1;
    if (structuralTokens > MAX_JSON_STRUCTURAL_TOKENS) return fail("$.snapshot.body", "exceeds the bounded JSON structure size");
  }
};

const assertUniqueObjectKeys = (root: Node): void => {
  const pending: Array<{ node: Node; path: string }> = [{ node: root, path: "$.snapshot.body" }];
  while (pending.length > 0) {
    const { node, path } = pending.pop()!;
    if (node.type === "object") {
      const seen = new Set<string>();
      for (const property of node.children ?? []) {
        const key = property.children?.[0]?.value;
        const child = property.children?.[1];
        if (typeof key !== "string" || child === undefined) return fail(path, "must contain complete JSON properties");
        if (seen.has(key)) return fail(`${path}.${key}`, "must not duplicate an object key");
        if (FORBIDDEN_OBJECT_KEYS.has(key)) return fail(`${path}.${key}`, `contains forbidden key ${key}`);
        seen.add(key);
        pending.push({ node: child, path: `${path}.${key}` });
      }
    } else if (node.type === "array") {
      (node.children ?? []).forEach((child, index) => pending.push({ node: child, path: `${path}[${index}]` }));
    }
  }
};

const parseReasoning = (value: unknown, path: string): ParsedOpenRouterModelRow["reasoning"] => {
  if (value === null) return null;
  const item = record(value, path);
  allowedKeys(item, ["mandatory", "default_enabled", "supported_efforts", "default_effort", "supports_max_tokens"], path);
  requiredKeys(item, ["mandatory"], path);
  if (typeof item.mandatory !== "boolean") return fail(`${path}.mandatory`, "must be boolean");
  if (item.default_enabled !== undefined && item.default_enabled !== null && typeof item.default_enabled !== "boolean") {
    return fail(`${path}.default_enabled`, "must be null or boolean when present");
  }
  const supportedEfforts = item.supported_efforts === undefined || item.supported_efforts === null
    ? []
    : textArray(item.supported_efforts, `${path}.supported_efforts`);
  const unsupportedEfforts = supportedEfforts.filter((effort) => !REASONING_EFFORTS.has(effort));
  if (unsupportedEfforts.length > 0) return fail(`${path}.supported_efforts`, `contains unsupported efforts: ${unsupportedEfforts.join(", ")}`);
  if (item.default_effort !== undefined && item.default_effort !== null) {
    const defaultEffort = text(item.default_effort, `${path}.default_effort`);
    if (!REASONING_EFFORTS.has(defaultEffort)) return fail(`${path}.default_effort`, "must be a supported reasoning effort");
  }
  if (item.supports_max_tokens !== undefined && item.supports_max_tokens !== null && typeof item.supports_max_tokens !== "boolean") {
    return fail(`${path}.supports_max_tokens`, "must be null or boolean when present");
  }
  return {
    mandatory: item.mandatory,
    defaultEnabled: item.default_enabled as boolean | null | undefined ?? null,
    supportedEfforts,
  };
};

const parseArtificialAnalysis = (value: unknown, path: string): ParsedOpenRouterModelRow["artificialAnalysis"] => {
  if (value === null) return null;
  const item = record(value, path);
  allowedKeys(item, ["intelligence_index", "coding_index", "agentic_index"], path);
  return {
    intelligence: item.intelligence_index === undefined ? null : boundedNumber(item.intelligence_index, `${path}.intelligence_index`),
    coding: item.coding_index === undefined ? null : boundedNumber(item.coding_index, `${path}.coding_index`),
    agentic: item.agentic_index === undefined ? null : boundedNumber(item.agentic_index, `${path}.agentic_index`),
  };
};

const parseDesignArena = (value: unknown, path: string): ParsedOpenRouterModelRow["designArena"] => {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) return fail(path, "must be a bounded array");
  const rows = value.map((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const item = record(entry, itemPath);
    exactKeys(item, ["arena", "category", "elo", "win_rate", "rank"], itemPath);
    if (item.arena !== "agents" && item.arena !== "models") return fail(`${itemPath}.arena`, "must be agents or models");
    const arena: "agents" | "models" = item.arena;
    return {
      arena,
      category: identityText(item.category, `${itemPath}.category`, MAX_DESIGN_CATEGORY_CHARACTERS),
      elo: numberBetween(item.elo, 0, 5_000, `${itemPath}.elo`),
      winRate: numberBetween(item.win_rate, 0, 100, `${itemPath}.win_rate`),
      rank: positiveInteger(item.rank, `${itemPath}.rank`),
    };
  });
  const identities = rows.map((row) => `${row.arena}/${row.category}`);
  if (new Set(identities).size !== identities.length) return fail(path, "must not duplicate an arena/category row");
  return rows.sort((left, right) => compareText(left.arena, right.arena) || compareText(left.category, right.category));
};

const validateRowMetadata = (item: Record<string, unknown>, path: string): void => {
  boundedSourceText(item.canonical_slug, `${path}.canonical_slug`);
  nullableBoundedText(item.hugging_face_id, `${path}.hugging_face_id`);
  boundedSourceText(item.name, `${path}.name`);
  positiveInteger(item.created, `${path}.created`);
  boundedSourceText(item.description, `${path}.description`);
  if (item.per_request_limits !== null) return fail(`${path}.per_request_limits`, "must be null until its schema is reviewed");
  validateDefaultParameters(item.default_parameters, `${path}.default_parameters`);
  if (item.supported_voices !== null) return fail(`${path}.supported_voices`, "must be null until its schema is reviewed");
  nullableText(item.knowledge_cutoff, `${path}.knowledge_cutoff`);
  nullableText(item.expiration_date, `${path}.expiration_date`);
  const links = record(item.links, `${path}.links`);
  exactKeys(links, ["details"], `${path}.links`);
  boundedSourceText(links.details, `${path}.links.details`);
};

const validateArchitectureMetadata = (architecture: Record<string, unknown>, path: string): void => {
  boundedSourceText(architecture.modality, `${path}.modality`);
  textArray(architecture.output_modalities, `${path}.output_modalities`);
  boundedSourceText(architecture.tokenizer, `${path}.tokenizer`);
  nullableBoundedText(architecture.instruct_type, `${path}.instruct_type`);
};

const parseRow = (value: unknown, index: number): ParsedOpenRouterModelRow => {
  const path = `$.snapshot.body.data[${index}]`;
  const item = record(value, path);
  const rowKeys = [
    "id", "canonical_slug", "hugging_face_id", "name", "created", "description",
    "context_length", "architecture", "pricing", "top_provider", "per_request_limits",
    "supported_parameters", "default_parameters", "supported_voices", "knowledge_cutoff",
    "expiration_date", "links", "benchmarks", "reasoning",
  ];
  allowedKeys(item, rowKeys, path);
  requiredKeys(item, rowKeys.filter((key) => key !== "benchmarks" && key !== "reasoning"), path);
  const architecture = record(item.architecture, `${path}.architecture`);
  exactKeys(architecture, ["modality", "input_modalities", "output_modalities", "tokenizer", "instruct_type"], `${path}.architecture`);
  validateArchitectureMetadata(architecture, `${path}.architecture`);
  const pricing = record(item.pricing, `${path}.pricing`);
  allowedKeys(pricing, [
    "prompt", "completion", "image", "audio", "web_search", "internal_reasoning",
    "input_cache_read", "input_cache_write", "input_cache_write_1h", "input_audio_cache",
    "image_output", "audio_output", "overrides",
  ], `${path}.pricing`);
  requiredKeys(pricing, ["prompt", "completion"], `${path}.pricing`);
  validatePricingExtras(pricing, `${path}.pricing`);
  const provider = record(item.top_provider, `${path}.top_provider`);
  exactKeys(provider, ["context_length", "max_completion_tokens", "is_moderated"], `${path}.top_provider`);
  if (typeof provider.is_moderated !== "boolean") return fail(`${path}.top_provider.is_moderated`, "must be boolean");
  const benchmarks = item.benchmarks === undefined ? null : record(item.benchmarks, `${path}.benchmarks`);
  if (benchmarks !== null) {
    allowedKeys(benchmarks, ["design_arena", "artificial_analysis"], `${path}.benchmarks`);
    requiredKeys(benchmarks, ["design_arena"], `${path}.benchmarks`);
  }
  validateRowMetadata(item, path);
  return {
    id: identityText(item.id, `${path}.id`, MAX_MODEL_ID_CHARACTERS),
    contextLength: positiveInteger(item.context_length, `${path}.context_length`),
    topProviderContextLength: optionalPositiveInteger(provider.context_length, `${path}.top_provider.context_length`),
    maxCompletionTokens: optionalPositiveInteger(provider.max_completion_tokens, `${path}.top_provider.max_completion_tokens`),
    promptPrice: availableDecimal(pricing.prompt, `${path}.pricing.prompt`),
    completionPrice: availableDecimal(pricing.completion, `${path}.pricing.completion`),
    inputModalities: textArray(architecture.input_modalities, `${path}.architecture.input_modalities`),
    supportedParameters: textArray(item.supported_parameters, `${path}.supported_parameters`),
    reasoning: item.reasoning === undefined ? null : parseReasoning(item.reasoning, `${path}.reasoning`),
    artificialAnalysis: benchmarks?.artificial_analysis === undefined
      ? null
      : parseArtificialAnalysis(benchmarks.artificial_analysis, `${path}.benchmarks.artificial_analysis`),
    designArena: benchmarks === null ? [] : parseDesignArena(benchmarks.design_arena, `${path}.benchmarks.design_arena`),
  };
};

export const parseOpenRouterModelRows = (body: string): ParsedOpenRouterModelRow[] => {
  preflightJsonBounds(body);
  const errors: ParseError[] = [];
  let tree: Node | undefined;
  try {
    tree = parseTree(body, errors, { allowTrailingComma: false, disallowComments: true });
  } catch {
    return fail("$.snapshot.body", "exceeds the bounded JSON parser capacity");
  }
  if (tree === undefined || errors.length > 0) return fail("$.snapshot.body", "must be strict valid JSON");
  assertUniqueObjectKeys(tree);
  const root = record(getNodeValue(tree), "$.snapshot.body");
  exactKeys(root, ["data", "total_count", "links"], "$.snapshot.body");
  if (!Array.isArray(root.data) || root.data.length === 0 || root.data.length > OPENROUTER_MAX_ROWS) {
    return fail("$.snapshot.body.data", `must contain between 1 and ${OPENROUTER_MAX_ROWS} model rows`);
  }
  if (root.total_count !== root.data.length) return fail("$.snapshot.body.total_count", "must equal data length");
  const links = record(root.links, "$.snapshot.body.links");
  exactKeys(links, ["next"], "$.snapshot.body.links");
  if (links.next !== null) return fail("$.snapshot.body.links.next", "must be null for a complete unpaginated snapshot");
  const rows = root.data.map(parseRow);
  if (new Set(rows.map((row) => row.id)).size !== rows.length) return fail("$.snapshot.body.data", "must use unique model ids");
  return rows;
};
