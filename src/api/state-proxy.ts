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
  return new Proxy({} as any, {
    get(_target, prop, _receiver) {
      if (typeof prop === "symbol") {
        if (prop === Symbol.toPrimitive) return undefined;
        if (prop === Symbol.iterator) {
          return buildIterator(getter, keysFn, prefix);
        }
        return undefined;
      }

      const path = prefix ? `${prefix}.${prop}` : prop;

      // Special: "get" method for backward-compat flat access
      if (!prefix && prop === "get") {
        return (key: string) => getter(key);
      }
      // "keys" property at root
      if (!prefix && prop === "keys") {
        return keysFn();
      }

      // Array-like methods when .length exists
      if (prop === "length") {
        const val = getter(`${path}`);
        return val !== undefined ? val : 0;
      }

      if (prop === "forEach" || prop === "map" || prop === "filter" || prop === "find" || prop === "some" || prop === "every" || prop === "reduce") {
        return buildArrayMethod(prop as string, getter, keysFn, prefix);
      }

      // Check if this is a leaf value
      const direct = getter(path);
      if (direct !== undefined) {
        return direct;
      }

      // Check if there are child keys — if so, return nested proxy
      const childPrefix = `${path}.`;
      const allKeys = keysFn();
      const hasChildren = allKeys.some(k => k.startsWith(childPrefix));
      if (hasChildren) {
        return createStateProxy(getter, keysFn, path);
      }

      return undefined;
    },

    has(_target, prop) {
      if (typeof prop === "symbol") return false;
      const path = prefix ? `${prefix}.${prop}` : String(prop);
      if (getter(path) !== undefined) return true;
      const childPrefix = `${path}.`;
      return keysFn().some(k => k.startsWith(childPrefix));
    },

    ownKeys(_target) {
      const pfx = prefix ? `${prefix}.` : "";
      const keys = new Set<string>();
      for (const k of keysFn()) {
        if (pfx && !k.startsWith(pfx)) continue;
        const rest = pfx ? k.slice(pfx.length) : k;
        const dot = rest.indexOf(".");
        keys.add(dot === -1 ? rest : rest.slice(0, dot));
      }
      return Array.from(keys);
    },

    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop === "symbol") return undefined;
      const path = prefix ? `${prefix}.${prop}` : String(prop);
      const val = getter(path);
      if (val !== undefined) {
        return { value: val, writable: false, enumerable: true, configurable: true };
      }
      const childPrefix = `${path}.`;
      if (keysFn().some(k => k.startsWith(childPrefix))) {
        return { value: createStateProxy(getter, keysFn, path), writable: false, enumerable: true, configurable: true };
      }
      return undefined;
    },
  });
}

function buildIterator(
  getter: (key: string) => unknown,
  keysFn: () => string[],
  prefix: string,
): () => Iterator<any> {
  return function* () {
    const len = getter(`${prefix}.length`);
    if (typeof len !== "number") return;
    for (let i = 0; i < len; i++) {
      const itemPath = `${prefix}.${i}`;
      const direct = getter(itemPath);
      if (direct !== undefined) {
        yield direct;
      } else {
        const childPrefix = `${itemPath}.`;
        if (keysFn().some(k => k.startsWith(childPrefix))) {
          yield createStateProxy(getter, keysFn, itemPath);
        } else {
          yield undefined;
        }
      }
    }
  };
}

function buildArrayMethod(
  method: string,
  getter: (key: string) => unknown,
  keysFn: () => string[],
  prefix: string,
): (...args: any[]) => any {
  return (...args: any[]) => {
    const len = getter(`${prefix}.length`);
    if (typeof len !== "number") return method === "map" || method === "filter" ? [] : undefined;

    const items: any[] = [];
    for (let i = 0; i < len; i++) {
      const itemPath = `${prefix}.${i}`;
      const direct = getter(itemPath);
      if (direct !== undefined) {
        items.push(direct);
      } else {
        const childPrefix = `${itemPath}.`;
        if (keysFn().some(k => k.startsWith(childPrefix))) {
          items.push(createStateProxy(getter, keysFn, itemPath));
        } else {
          items.push(undefined);
        }
      }
    }

    return (items as any)[method](...args);
  };
}
