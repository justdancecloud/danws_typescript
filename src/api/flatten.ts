const MAX_DEPTH = 10;

type Leaf = string | number | boolean | bigint | null | undefined | Date | Uint8Array;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false;
  if (Array.isArray(v)) return false;
  if (v instanceof Date || v instanceof Uint8Array) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Flatten an object/array into a Map of dot-path → leaf value.
 * Arrays get an additional `.length` key.
 */
export function flattenValue(
  prefix: string,
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): Map<string, Leaf> {
  const result = new Map<string, Leaf>();

  if (depth > MAX_DEPTH) {
    throw new Error(`Auto-flatten depth limit exceeded (max ${MAX_DEPTH}) at path "${prefix}"`);
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error(`Circular reference detected at path "${prefix}"`);
    seen.add(value);
    const prefixDot = prefix + ".";
    result.set(prefixDot + "length", value.length);
    for (let i = 0; i < value.length; i++) {
      const childPath = prefixDot + i;
      const child = value[i];
      if (isPlainObject(child) || Array.isArray(child)) {
        for (const [k, v] of flattenValue(childPath, child, depth + 1, seen)) {
          result.set(k, v);
        }
      } else {
        result.set(childPath, child as Leaf);
      }
    }
    return result;
  }

  if (isPlainObject(value)) {
    if (seen.has(value)) throw new Error(`Circular reference detected at path "${prefix}"`);
    seen.add(value);
    const prefixDot = prefix + ".";
    for (const [key, child] of Object.entries(value)) {
      const childPath = prefixDot + key;
      if (isPlainObject(child) || Array.isArray(child)) {
        for (const [k, v] of flattenValue(childPath, child, depth + 1, seen)) {
          result.set(k, v);
        }
      } else {
        result.set(childPath, child as Leaf);
      }
    }
    return result;
  }

  // Leaf value — not an object/array
  result.set(prefix, value as Leaf);
  return result;
}

/**
 * Check if a value should be auto-flattened (plain object or array).
 */
export function shouldFlatten(value: unknown): boolean {
  return isPlainObject(value) || Array.isArray(value);
}
