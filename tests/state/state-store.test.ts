import { describe, it, expect } from "vitest";
import { StateStore } from "../../src/state/state-store.js";

describe("StateStore", () => {
  it("set and get", () => {
    const store = new StateStore();
    store.set(1, "hello");
    expect(store.get(1)).toBe("hello");
  });

  it("returns undefined for unset keys", () => {
    const store = new StateStore();
    expect(store.get(999)).toBeUndefined();
  });

  it("overwrites existing values", () => {
    const store = new StateStore();
    store.set(1, "old");
    store.set(1, "new");
    expect(store.get(1)).toBe("new");
  });

  it("has checks existence", () => {
    const store = new StateStore();
    store.set(1, null);
    expect(store.has(1)).toBe(true);
    expect(store.has(2)).toBe(false);
  });

  it("getAll returns copy of all values", () => {
    const store = new StateStore();
    store.set(1, "a");
    store.set(2, "b");
    const all = store.getAll();
    expect(all.size).toBe(2);
    expect(all.get(1)).toBe("a");
    expect(all.get(2)).toBe("b");

    // Mutating returned map doesn't affect store
    all.set(3, "c");
    expect(store.has(3)).toBe(false);
  });

  it("clear removes all", () => {
    const store = new StateStore();
    store.set(1, "a");
    store.set(2, "b");
    store.clear();
    expect(store.has(1)).toBe(false);
    expect(store.has(2)).toBe(false);
  });
});
