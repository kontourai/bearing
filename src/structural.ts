export type StructuralFailure = (path: string, message: string) => never;

export const plainRecord = (value: unknown, path: string, fail: StructuralFailure): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path, "must be an object");
  const object = value as object;
  const prototype = Object.getPrototypeOf(object);
  if (prototype !== Object.prototype && prototype !== null) fail(path, "must be a plain object");
  for (const key of Reflect.ownKeys(object)) {
    if (typeof key !== "string") fail(path, "must not contain symbol keys");
    const property = String(key);
    const descriptor = Object.getOwnPropertyDescriptor(object, property);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      fail(`${path}.${property}`, "must be an enumerable data property");
    }
  }
  return value as Record<string, unknown>;
};

export const plainArray = (value: unknown, path: string, allowEmpty: boolean, fail: StructuralFailure): unknown[] => {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    fail(path, allowEmpty ? "must be an array" : "must be a non-empty array");
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) fail(path, "must be a plain array");
  const items = value as unknown[];
  for (const key of Reflect.ownKeys(items)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= items.length) {
      fail(path, "must not contain custom array properties");
    }
  }
  for (let index = 0; index < items.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(items, String(index));
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      fail(`${path}[${index}]`, "must be an own enumerable data element");
    }
  }
  return items;
};

export const allowOnlyKeys = (
  value: Record<string, unknown>,
  keys: string[],
  path: string,
  fail: StructuralFailure,
  message = "is not supported",
): void => {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${path}.${key}`, message);
};

export const requireOwnKeys = (value: Record<string, unknown>, keys: string[], path: string, fail: StructuralFailure): void => {
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, "is required");
};
