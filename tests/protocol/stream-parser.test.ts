import { describe, it, expect } from "vitest";
import { createStreamParser } from "../../src/protocol/stream-parser.js";
import { encode, encodeBatch, encodeHeartbeat } from "../../src/protocol/codec.js";
import { DataType, FrameType } from "../../src/protocol/types.js";
import type { Frame } from "../../src/protocol/types.js";

describe("Stream Parser", () => {
  it("parses a single frame", () => {
    const parser = createStreamParser();
    const frames: Frame[] = [];
    parser.onFrame((f) => frames.push(f));

    const data = encode({
      frameType: FrameType.ServerValue,
      keyId: 0x0001,
      dataType: DataType.Bool,
      payload: true,
    });

    parser.feed(data);
    expect(frames).toHaveLength(1);
    expect(frames[0].payload).toBe(true);
  });

  it("parses batch of frames", () => {
    const parser = createStreamParser();
    const frames: Frame[] = [];
    parser.onFrame((f) => frames.push(f));

    const batch = encodeBatch([
      { frameType: FrameType.ServerValue, keyId: 0x0001, dataType: DataType.Bool, payload: true },
      { frameType: FrameType.ServerValue, keyId: 0x0002, dataType: DataType.String, payload: "hello" },
      { frameType: FrameType.ServerSync, keyId: 0, dataType: DataType.Null, payload: null },
    ]);

    parser.feed(batch);
    expect(frames).toHaveLength(3);
    expect(frames[0].payload).toBe(true);
    expect(frames[1].payload).toBe("hello");
    expect(frames[2].frameType).toBe(FrameType.ServerSync);
  });

  it("handles byte-by-byte feeding", () => {
    const parser = createStreamParser();
    const frames: Frame[] = [];
    parser.onFrame((f) => frames.push(f));

    const data = encode({
      frameType: FrameType.ServerValue,
      keyId: 0x0003,
      dataType: DataType.Uint32,
      payload: 1000,
    });

    for (let i = 0; i < data.length; i++) {
      parser.feed(new Uint8Array([data[i]]));
    }

    expect(frames).toHaveLength(1);
    expect(frames[0].payload).toBe(1000);
  });

  it("handles frame split across chunks", () => {
    const parser = createStreamParser();
    const frames: Frame[] = [];
    parser.onFrame((f) => frames.push(f));

    const data = encode({
      frameType: FrameType.ServerValue,
      keyId: 0x0001,
      dataType: DataType.String,
      payload: "Hello, World!",
    });

    // Split at arbitrary point
    const mid = Math.floor(data.length / 2);
    parser.feed(data.subarray(0, mid));
    expect(frames).toHaveLength(0);
    parser.feed(data.subarray(mid));
    expect(frames).toHaveLength(1);
    expect(frames[0].payload).toBe("Hello, World!");
  });

  it("recognizes heartbeat", () => {
    const parser = createStreamParser();
    let heartbeats = 0;
    parser.onHeartbeat(() => heartbeats++);

    parser.feed(encodeHeartbeat());
    expect(heartbeats).toBe(1);

    // Heartbeat split across chunks
    parser.feed(new Uint8Array([0x10]));
    parser.feed(new Uint8Array([0x05]));
    expect(heartbeats).toBe(2);
  });

  it("interleaves heartbeats and frames", () => {
    const parser = createStreamParser();
    const frames: Frame[] = [];
    let heartbeats = 0;
    parser.onFrame((f) => frames.push(f));
    parser.onHeartbeat(() => heartbeats++);

    const frame1 = encode({
      frameType: FrameType.ServerValue,
      keyId: 0x0001,
      dataType: DataType.Bool,
      payload: true,
    });
    const hb = encodeHeartbeat();
    const frame2 = encode({
      frameType: FrameType.ServerValue,
      keyId: 0x0002,
      dataType: DataType.Uint8,
      payload: 42,
    });

    // Concatenate: frame + heartbeat + frame
    const combined = new Uint8Array(frame1.length + hb.length + frame2.length);
    combined.set(frame1, 0);
    combined.set(hb, frame1.length);
    combined.set(frame2, frame1.length + hb.length);

    parser.feed(combined);
    expect(frames).toHaveLength(2);
    expect(heartbeats).toBe(1);
  });

  it("handles DLE-escaped payload in stream", () => {
    const parser = createStreamParser();
    const frames: Frame[] = [];
    parser.onFrame((f) => frames.push(f));

    // String containing 0x10
    const frame = encode({
      frameType: FrameType.ServerValue,
      keyId: 0x0001,
      dataType: DataType.String,
      payload: "A\x10B",
    });

    parser.feed(frame);
    expect(frames).toHaveLength(1);
    expect(frames[0].payload).toBe("A\x10B");
  });

  it("reports error on invalid DLE sequence", () => {
    const parser = createStreamParser();
    const errors: Error[] = [];
    parser.onError((e) => errors.push(e));

    // DLE followed by invalid byte (0x07) outside a frame
    parser.feed(new Uint8Array([0x10, 0x07]));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("0x10 0x07");
  });

  it("reports error on unexpected byte outside frame", () => {
    const parser = createStreamParser();
    const errors: Error[] = [];
    parser.onError((e) => errors.push(e));

    parser.feed(new Uint8Array([0x42]));
    expect(errors).toHaveLength(1);
  });

  it("recovers after error and parses next frame", () => {
    const parser = createStreamParser();
    const frames: Frame[] = [];
    const errors: Error[] = [];
    parser.onFrame((f) => frames.push(f));
    parser.onError((e) => errors.push(e));

    const validFrame = encode({
      frameType: FrameType.ServerValue,
      keyId: 0x0001,
      dataType: DataType.Bool,
      payload: false,
    });

    // Bad byte, then valid frame
    const combined = new Uint8Array(1 + validFrame.length);
    combined[0] = 0x42; // unexpected
    combined.set(validFrame, 1);

    parser.feed(combined);
    expect(errors).toHaveLength(1);
    expect(frames).toHaveLength(1);
    expect(frames[0].payload).toBe(false);
  });

  it("reset clears internal state", () => {
    const parser = createStreamParser();
    const frames: Frame[] = [];
    parser.onFrame((f) => frames.push(f));

    const data = encode({
      frameType: FrameType.ServerValue,
      keyId: 0x0001,
      dataType: DataType.Bool,
      payload: true,
    });

    // Feed partial frame, then reset
    parser.feed(data.subarray(0, 4));
    parser.reset();

    // Feed complete frame
    parser.feed(data);
    expect(frames).toHaveLength(1);
  });

  it("multiple onFrame callbacks fire in order", () => {
    const parser = createStreamParser();
    const order: number[] = [];
    parser.onFrame(() => order.push(1));
    parser.onFrame(() => order.push(2));

    parser.feed(encode({
      frameType: FrameType.ServerSync,
      keyId: 0,
      dataType: DataType.Null,
      payload: null,
    }));

    expect(order).toEqual([1, 2]);
  });

  it("handles keyId containing 0x10 byte", () => {
    const parser = createStreamParser();
    const frames: Frame[] = [];
    parser.onFrame((f) => frames.push(f));

    // KeyID 0x0010 — the low byte is 0x10, which gets DLE-escaped
    const frame = encode({
      frameType: FrameType.ServerValue,
      keyId: 0x0010,
      dataType: DataType.Bool,
      payload: true,
    });

    parser.feed(frame);
    expect(frames).toHaveLength(1);
    expect(frames[0].keyId).toBe(0x0010);
    expect(frames[0].payload).toBe(true);
  });
});
