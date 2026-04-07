import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BulkQueue } from "../../src/connection/bulk-queue.js";
import { FrameType, DataType } from "../../src/protocol/types.js";
import { decode } from "../../src/protocol/codec.js";
import type { Frame } from "../../src/protocol/types.js";

describe("BulkQueue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function makeValueFrame(keyId: number, value: unknown): Frame {
    return { frameType: FrameType.ServerValue, keyId, dataType: DataType.Uint8, payload: value };
  }

  function makeSyncFrame(): Frame {
    return { frameType: FrameType.ServerSync, keyId: 0, dataType: DataType.Null, payload: null };
  }

  it("flushes after 100ms", () => {
    const queue = new BulkQueue();
    const flushed: Uint8Array[] = [];
    queue.onFlush((data) => flushed.push(data));

    queue.enqueue(makeValueFrame(1, 42));
    expect(flushed).toHaveLength(0);

    vi.advanceTimersByTime(99);
    expect(flushed).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(flushed).toHaveLength(1);

    // Verify the flushed data is a valid encoded batch (+1 for SERVER_FLUSH_END)
    const frames = decode(flushed[0]);
    expect(frames).toHaveLength(2);
    expect(frames[0].payload).toBe(42);
    expect(frames[1].frameType).toBe(FrameType.ServerFlushEnd);
  });

  it("deduplicates value frames per keyId", () => {
    const queue = new BulkQueue();
    const flushed: Uint8Array[] = [];
    queue.onFlush((data) => flushed.push(data));

    queue.enqueue(makeValueFrame(1, 10));
    queue.enqueue(makeValueFrame(1, 20));
    queue.enqueue(makeValueFrame(1, 30));

    vi.advanceTimersByTime(100);
    const frames = decode(flushed[0]);
    expect(frames).toHaveLength(2); // 1 deduped value + FLUSH_END
    expect(frames[0].payload).toBe(30); // Only latest
  });

  it("does not deduplicate non-value frames", () => {
    const queue = new BulkQueue();
    const flushed: Uint8Array[] = [];
    queue.onFlush((data) => flushed.push(data));

    queue.enqueue(makeSyncFrame());
    queue.enqueue(makeSyncFrame());

    vi.advanceTimersByTime(100);
    const frames = decode(flushed[0]);
    expect(frames).toHaveLength(3); // 2 sync + FLUSH_END
  });

  it("mixes value and non-value frames", () => {
    const queue = new BulkQueue();
    const flushed: Uint8Array[] = [];
    queue.onFlush((data) => flushed.push(data));

    queue.enqueue(makeSyncFrame());
    queue.enqueue(makeValueFrame(1, 42));
    queue.enqueue(makeValueFrame(2, 99));

    vi.advanceTimersByTime(100);
    const frames = decode(flushed[0]);
    expect(frames).toHaveLength(4); // 1 sync + 2 values + FLUSH_END
  });

  it("does not send if queue is empty at fire time", () => {
    const queue = new BulkQueue();
    const flushed: Uint8Array[] = [];
    queue.onFlush((data) => flushed.push(data));

    queue.enqueue(makeValueFrame(1, 1));
    queue.clear();

    vi.advanceTimersByTime(100);
    expect(flushed).toHaveLength(0);
  });

  it("flush() sends immediately and resets timer", () => {
    const queue = new BulkQueue();
    const flushed: Uint8Array[] = [];
    queue.onFlush((data) => flushed.push(data));

    queue.enqueue(makeValueFrame(1, 1));
    queue.flush();
    expect(flushed).toHaveLength(1);

    // Timer should not fire again
    vi.advanceTimersByTime(200);
    expect(flushed).toHaveLength(1);
  });

  it("pending returns count of queued items", () => {
    const queue = new BulkQueue();
    expect(queue.pending).toBe(0);

    queue.enqueue(makeSyncFrame());
    queue.enqueue(makeValueFrame(1, 1));
    queue.enqueue(makeValueFrame(2, 2));
    expect(queue.pending).toBe(3); // 1 non-value + 2 value keys

    queue.enqueue(makeValueFrame(1, 99)); // dedup
    expect(queue.pending).toBe(3);
  });

  it("clearValueFrames removes only value frames", () => {
    const queue = new BulkQueue();
    queue.enqueue(makeSyncFrame());
    queue.enqueue(makeValueFrame(1, 1));

    queue.clearValueFrames();
    expect(queue.pending).toBe(1); // Only sync remains
  });

  it("timer restarts on new enqueue after flush", () => {
    const queue = new BulkQueue();
    const flushed: Uint8Array[] = [];
    queue.onFlush((data) => flushed.push(data));

    queue.enqueue(makeValueFrame(1, 1));
    vi.advanceTimersByTime(100);
    expect(flushed).toHaveLength(1);

    queue.enqueue(makeValueFrame(2, 2));
    vi.advanceTimersByTime(100);
    expect(flushed).toHaveLength(2);
  });
});
