import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ReconnectEngine, OfflineQueue } from "../../src/connection/reconnect-engine.js";

describe("ReconnectEngine", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("calculates exponential backoff delay", () => {
    const engine = new ReconnectEngine({
      baseDelay: 1000,
      backoffMultiplier: 2,
      maxDelay: 30000,
      jitter: false,
    });

    expect(engine.calculateDelay(1)).toBe(1000);
    expect(engine.calculateDelay(2)).toBe(2000);
    expect(engine.calculateDelay(3)).toBe(4000);
    expect(engine.calculateDelay(4)).toBe(8000);
    expect(engine.calculateDelay(5)).toBe(16000);
    expect(engine.calculateDelay(6)).toBe(30000); // capped
    expect(engine.calculateDelay(7)).toBe(30000); // still capped
  });

  it("applies jitter (0.5x to 1.5x)", () => {
    const engine = new ReconnectEngine({
      baseDelay: 1000,
      backoffMultiplier: 2,
      maxDelay: 30000,
      jitter: true,
    });

    // Run many times and check range
    for (let i = 0; i < 100; i++) {
      const delay = engine.calculateDelay(1);
      expect(delay).toBeGreaterThanOrEqual(500);
      expect(delay).toBeLessThan(1500);
    }
  });

  it("fires onReconnect callback with attempt and delay", () => {
    const onReconnect = vi.fn();
    const engine = new ReconnectEngine({
      maxRetries: 3,
      baseDelay: 100,
      jitter: false,
      backoffMultiplier: 2,
      maxDelay: 30000,
    });
    engine.onReconnect(onReconnect);
    engine.start();

    expect(onReconnect).toHaveBeenCalledWith(1, 100);
    expect(engine.isActive).toBe(true);
    expect(engine.attempt).toBe(1);

    engine.stop();
  });

  it("exhausts maxRetries and fires onExhausted", () => {
    const onReconnect = vi.fn();
    const onExhausted = vi.fn();
    const engine = new ReconnectEngine({
      maxRetries: 2,
      baseDelay: 100,
      jitter: false,
      backoffMultiplier: 1,
      maxDelay: 30000,
    });
    engine.onReconnect(onReconnect);
    engine.onExhausted(onExhausted);
    engine.start();

    // Attempt 1
    expect(engine.attempt).toBe(1);
    vi.advanceTimersByTime(100);
    engine.retry(); // fail → attempt 2

    expect(engine.attempt).toBe(2);
    vi.advanceTimersByTime(100);
    engine.retry(); // fail → attempt 3, exceeds maxRetries=2

    expect(onExhausted).toHaveBeenCalledOnce();
    expect(engine.isActive).toBe(false);
  });

  it("stop resets state", () => {
    const engine = new ReconnectEngine({ maxRetries: 10, baseDelay: 100, jitter: false });
    engine.start();
    expect(engine.isActive).toBe(true);

    engine.stop();
    expect(engine.isActive).toBe(false);
    expect(engine.attempt).toBe(0);
  });

  it("does nothing when disabled", () => {
    const onReconnect = vi.fn();
    const engine = new ReconnectEngine({ enabled: false });
    engine.onReconnect(onReconnect);
    engine.start();

    expect(engine.isActive).toBe(false);
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it("unlimited retries when maxRetries=0", () => {
    const onReconnect = vi.fn();
    const onExhausted = vi.fn();
    const engine = new ReconnectEngine({
      maxRetries: 0,
      baseDelay: 10,
      jitter: false,
      backoffMultiplier: 1,
      maxDelay: 100,
    });
    engine.onReconnect(onReconnect);
    engine.onExhausted(onExhausted);
    engine.start();

    for (let i = 0; i < 50; i++) {
      vi.advanceTimersByTime(10);
      engine.retry();
    }

    expect(onExhausted).not.toHaveBeenCalled();
    expect(engine.isActive).toBe(true);
    expect(engine.attempt).toBe(51);

    engine.stop();
  });
});

describe("OfflineQueue", () => {
  it("stores latest value per key", () => {
    const q = new OfflineQueue();
    q.set("a", 1);
    q.set("a", 2);
    q.set("b", 3);

    expect(q.size).toBe(2);

    const drained = q.drain();
    expect(drained.get("a")).toBe(2);
    expect(drained.get("b")).toBe(3);
    expect(q.size).toBe(0);
  });

  it("evicts oldest keys when exceeding maxSize", () => {
    const q = new OfflineQueue(3);
    q.set("a", 1);
    q.set("b", 2);
    q.set("c", 3);
    q.set("d", 4); // evicts "a"

    expect(q.size).toBe(3);
    const drained = q.drain();
    expect(drained.has("a")).toBe(false);
    expect(drained.get("b")).toBe(2);
    expect(drained.get("d")).toBe(4);
  });

  it("updating existing key does not count as new entry for eviction", () => {
    const q = new OfflineQueue(2);
    q.set("a", 1);
    q.set("b", 2);
    q.set("a", 99); // update, not new

    expect(q.size).toBe(2);
    const drained = q.drain();
    expect(drained.get("a")).toBe(99);
    expect(drained.get("b")).toBe(2);
  });

  it("clear removes all", () => {
    const q = new OfflineQueue();
    q.set("a", 1);
    q.set("b", 2);
    q.clear();
    expect(q.size).toBe(0);
  });

  it("drain empties the queue", () => {
    const q = new OfflineQueue();
    q.set("x", 42);
    const first = q.drain();
    expect(first.size).toBe(1);

    const second = q.drain();
    expect(second.size).toBe(0);
  });
});
