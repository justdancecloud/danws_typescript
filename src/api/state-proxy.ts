/**
 * Creates a Proxy that wraps a flat key-value getter into nested object access.
 * - `proxy.user.name` → `getter("user.name")`
 * - If `<path>.length` exists, treats that path as an array-like with iteration support.
 */
export function createStateProxy(
  getter: (key: string) => unknown,
  keysFn: () => string[],
  prefix = "",
): Record<string, any> {
  // Prefix index with reference-identity caching.
  // Rebuilt when the keys array reference changes (covers add, delete, and swap).
  let _cachedPrefixSet: Set<string> | null = null;
  let _lastKeysRef: string[] | null = null;
  let _cachedOwnKeys: string[] | null = null;
  let _ownKeysRef: string[] | null = null;

  function prefixSet(): Set<string> {
    const keys = keysFn();
    if (_cachedPrefixSet && keys === _lastKeysRef) return _cachedPrefixSet;
    const set = new Set<string>();
    for (const k of keys) {
      let dot = k.indexOf(".");
      while (dot !== -1) {
        set.add(k.slice(0, dot + 1)); // "user." , "user.scores." etc
        dot = k.indexOf(".", dot + 1);
      }
    }
    _cachedPrefixSet = set;
    _lastKeysRef = keys;
    return set;
  }

  function hasChildren(path: string): boolean {
    return prefixSet().has(path + ".");
  }

  function resolveItem(itemPath: string): unknown {
    const direct = getter(itemPath);
    if (direct !== undefined) return direct;
    if (hasChildren(itemPath)) return createStateProxy(getter, keysFn, itemPath);
    return undefined;
  }

  return new Proxy({} as any, {
    get(_target, prop, _receiver) {
      if (typeof prop === "symbol") {
        if (prop === Symbol.iterator) return buildIterator(getter, prefix, resolveItem);
        return undefined;
      }

      const path = prefix ? `${prefix}.${prop}` : prop;

      // Special: "get" method for backward-compat flat access
      if (!prefix && prop === "get") return (key: string) => getter(key);
      if (!prefix && prop === "keys") return keysFn();

      // Array-like
      if (prop === "length") {
        const val = getter(`${path}`);
        return val !== undefined ? val : 0;
      }

      if (prop === "forEach" || prop === "map" || prop === "filter" ||
          prop === "find" || prop === "some" || prop === "every" || prop === "reduce") {
        return buildArrayMethod(prop as string, getter, prefix, resolveItem);
      }

      // Leaf value
      const direct = getter(path);
      if (direct !== undefined) return direct;

      // Nested proxy
      if (hasChildren(path)) return createStateProxy(getter, keysFn, path);

      return undefined;
    },

    has(_target, prop) {
      if (typeof prop === "symbol") return false;
      const path = prefix ? `${prefix}.${prop}` : String(prop);
      return getter(path) !== undefined || hasChildren(path);
    },

    ownKeys(_target) {
      const currentKeys = keysFn();
      if (_cachedOwnKeys && currentKeys === _ownKeysRef) return _cachedOwnKeys;
      const pfx = prefix ? `${prefix}.` : "";
      const keys = new Set<string>();
      for (const k of currentKeys) {
        if (pfx && !k.startsWith(pfx)) continue;
        const rest = pfx ? k.slice(pfx.length) : k;
        const dot = rest.indexOf(".");
        keys.add(dot === -1 ? rest : rest.slice(0, dot));
      }
      _cachedOwnKeys = Array.from(keys);
      _ownKeysRef = currentKeys;
      return _cachedOwnKeys;
    },

    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop === "symbol") return undefined;
      const path = prefix ? `${prefix}.${prop}` : String(prop);
      const val = getter(path);
      if (val !== undefined) {
        return { value: val, writable: false, enumerable: true, configurable: true };
      }
      if (hasChildren(path)) {
        return { value: createStateProxy(getter, keysFn, path), writable: false, enumerable: true, configurable: true };
      }
      return undefined;
    },
  });
}

function buildIterator(
  getter: (key: string) => unknown,
  prefix: string,
  resolveItem: (path: string) => unknown,
): () => Iterator<any> {
  return function* () {
    const len = getter(`${prefix}.length`);
    if (typeof len !== "number") return;
    for (let i = 0; i < len; i++) {
      yield resolveItem(`${prefix}.${i}`);
    }
  };
}

function buildArrayMethod(
  method: string,
  getter: (key: string) => unknown,
  prefix: string,
  resolveItem: (path: string) => unknown,
): (...args: any[]) => any {
  return (...args: any[]) => {
    const len = getter(`${prefix}.length`);
    if (typeof len !== "number") return method === "map" || method === "filter" ? [] : undefined;

    const items: any[] = [];
    for (let i = 0; i < len; i++) {
      items.push(resolveItem(`${prefix}.${i}`));
    }

    return (items as any)[method](...args);
  };
}
