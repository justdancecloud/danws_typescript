import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HeartbeatManager } from "../../src/connection/heartbeat-manager.js";

describe("HeartbeatManager", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends heartbeat every 10 seconds", () => {
    const hb = new HeartbeatManager();
    const sent: Uint8Array[] = [];
    hb.onSend((data) => sent.push(data));
    hb.start();

    // Simulate receiving heartbeats to prevent timeout
    vi.advanceTimersByTime(10000);
    hb.received();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual(new Uint8Array([0x10, 0x05]));

    vi.advanceTimersByTime(10000);
    hb.received();
    expect(sent).toHaveLength(2);

    vi.advanceTimersByTime(10000);
    expect(sent).toHaveLength(3);

    hb.stop();
  });

  it("fires timeout after 15 seconds without receiving", () => {
    const hb = new HeartbeatManager();
    const onTimeout = vi.fn();
    hb.onTimeout(onTimeout);
    hb.start();

    // Timeout check runs every 1s. At 16s, Date.now()-lastReceived > 15000
    vi.advanceTimersByTime(15000);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000); // 16s — timeout fires
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it("received() resets timeout", () => {
    const hb = new HeartbeatManager();
    const onTimeout = vi.fn();
    hb.onTimeout(onTimeout);
    hb.start();

    vi.advanceTimersByTime(14000);
    hb.received(); // Reset at 14s

    vi.advanceTimersByTime(14000); // 28s total, 14s from last received
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000); // 30s total, 16s from last received
    expect(onTimeout).toHaveBeenCalledOnce();

    hb.stop();
  });

  it("stop cancels timers", () => {
    const hb = new HeartbeatManager();
    const sent: Uint8Array[] = [];
    const onTimeout = vi.fn();
    hb.onSend((data) => sent.push(data));
    hb.onTimeout(onTimeout);
    hb.start();

    hb.stop();
    expect(hb.isRunning).toBe(false);

    vi.advanceTimersByTime(20000);
    expect(sent).toHaveLength(0);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("isRunning reflects state", () => {
    const hb = new HeartbeatManager();
    expect(hb.isRunning).toBe(false);
    hb.start();
    expect(hb.isRunning).toBe(true);
    hb.stop();
    expect(hb.isRunning).toBe(false);
  });
});
