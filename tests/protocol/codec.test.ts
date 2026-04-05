import { describe, it, expect } from "vitest";
import { encode, decode, encodeBatch, encodeHeartbeat } from "../../src/protocol/codec.js";
import { DataType, FrameType, DanWSError } from "../../src/protocol/types.js";
import type { Frame } from "../../src/protocol/types.js";

function hex(arr: Uint8Array): string {
  return Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join(" ");
}

describe("Codec", () => {
  describe("Wire Examples from Spec", () => {
    it("9.1 Server Key Registration — root.status.alive, bool, keyId 0x0001", () => {
      const frame: Frame = {
        frameType: FrameType.ServerKeyRegistration,
        keyId: 0x0001,
        dataType: DataType.Bool,
        payload: "root.status.alive",
      };
      const bytes = encode(frame);
      const expected = new Uint8Array([
        0x10, 0x02, 0x00, 0x00, 0x01, 0x01,
        // "root.status.alive" UTF-8
        0x72, 0x6f, 0x6f, 0x74, 0x2e, 0x73, 0x74, 0x61, 0x74, 0x75, 0x73, 0x2e, 0x61, 0x6c, 0x69, 0x76, 0x65,
        0x10, 0x03,
      ]);
      expect(hex(bytes)).toBe(hex(expected));
    });

    it("9.2 Server Value — bool true, keyId 0x0001", () => {
      const frame: Frame = {
        frameType: FrameType.ServerValue,
        keyId: 0x0001,
        dataType: DataType.Bool,
        payload: true,
      };
      const bytes = encode(frame);
      const expected = new Uint8Array([0x10, 0x02, 0x01, 0x00, 0x01, 0x01, 0x01, 0x10, 0x03]);
      expect(hex(bytes)).toBe(hex(expected));
    });

    it("9.3 Server Value — string 'Alice', keyId 0x0002", () => {
      const frame: Frame = {
        frameType: FrameType.ServerValue,
        keyId: 0x0002,
        dataType: DataType.String,
        payload: "Alice",
      };
      const bytes = encode(frame);
      const expected = new Uint8Array([
        0x10, 0x02, 0x01, 0x00, 0x02, 0x0a,
        0x41, 0x6c, 0x69, 0x63, 0x65,
        0x10, 0x03,
      ]);
      expect(hex(bytes)).toBe(hex(expected));
    });

    it("9.4 Server Value — uint32 1000, keyId 0x0003", () => {
      const frame: Frame = {
        frameType: FrameType.ServerValue,
        keyId: 0x0003,
        dataType: DataType.Uint32,
        payload: 1000,
      };
      const bytes = encode(frame);
      const expected = new Uint8Array([
        0x10, 0x02, 0x01, 0x00, 0x03, 0x04,
        0x00, 0x00, 0x03, 0xe8,
        0x10, 0x03,
      ]);
      expect(hex(bytes)).toBe(hex(expected));
    });

    it("9.5 Server Value — float32 23.5, keyId 0x0004", () => {
      const frame: Frame = {
        frameType: FrameType.ServerValue,
        keyId: 0x0004,
        dataType: DataType.Float32,
        payload: 23.5,
      };
      const bytes = encode(frame);
      const expected = new Uint8Array([
        0x10, 0x02, 0x01, 0x00, 0x04, 0x08,
        0x41, 0xbc, 0x00, 0x00,
        0x10, 0x03,
      ]);
      expect(hex(bytes)).toBe(hex(expected));
    });

    it("9.7 Signal frames", () => {
      const signals: Array<[FrameType, number[]]> = [
        [FrameType.ServerSync, [0x10, 0x02, 0x04, 0x00, 0x00, 0x00, 0x10, 0x03]],
        [FrameType.ClientReady, [0x10, 0x02, 0x05, 0x00, 0x00, 0x00, 0x10, 0x03]],
        [FrameType.ClientSync, [0x10, 0x02, 0x06, 0x00, 0x00, 0x00, 0x10, 0x03]],
        [FrameType.ServerReady, [0x10, 0x02, 0x07, 0x00, 0x00, 0x00, 0x10, 0x03]],
        [FrameType.ServerReset, [0x10, 0x02, 0x09, 0x00, 0x00, 0x00, 0x10, 0x03]],
        [FrameType.ClientResyncReq, [0x10, 0x02, 0x0a, 0x00, 0x00, 0x00, 0x10, 0x03]],
        [FrameType.AuthOk, [0x10, 0x02, 0x0f, 0x00, 0x00, 0x00, 0x10, 0x03]],
      ];

      for (const [ft, expected] of signals) {
        const frame: Frame = { frameType: ft, keyId: 0, dataType: DataType.Null, payload: null };
        const bytes = encode(frame);
        expect(hex(bytes)).toBe(hex(new Uint8Array(expected)));
      }
    });

    it("9.10 Client Key Registration + Value", () => {
      const reg: Frame = {
        frameType: FrameType.ClientKeyRegistration,
        keyId: 0x0001,
        dataType: DataType.Float32,
        payload: "input.joystick.x",
      };
      const regBytes = encode(reg);
      const expectedReg = new Uint8Array([
        0x10, 0x02, 0x02, 0x00, 0x01, 0x08,
        // "input.joystick.x"
        0x69, 0x6e, 0x70, 0x75, 0x74, 0x2e, 0x6a, 0x6f, 0x79, 0x73, 0x74, 0x69, 0x63, 0x6b, 0x2e, 0x78,
        0x10, 0x03,
      ]);
      expect(hex(regBytes)).toBe(hex(expectedReg));

      const val: Frame = {
        frameType: FrameType.ClientValue,
        keyId: 0x0001,
        dataType: DataType.Float32,
        payload: -0.75,
      };
      const valBytes = encode(val);
      const expectedVal = new Uint8Array([
        0x10, 0x02, 0x03, 0x00, 0x01, 0x08,
        0xbf, 0x40, 0x00, 0x00,
        0x10, 0x03,
      ]);
      expect(hex(valBytes)).toBe(hex(expectedVal));
    });

    it("9.12 DLE escaping in frame — string with 0x10", () => {
      const frame: Frame = {
        frameType: FrameType.ServerValue,
        keyId: 0x0010,
        dataType: DataType.String,
        payload: "Hello\x10World",
      };
      const bytes = encode(frame);
      // KeyID 0x0010: high byte 0x00, low byte 0x10 — but keyId is in the header, not escaped
      // Wait, keyId bytes ARE in the header which is NOT escaped since they are part of the body
      // Actually looking at the spec example 9.12, the frame is:
      // 10 02 01 00 10 0A 48 65 6C 6C 6F 10 10 57 6F 72 6C 64 10 03
      // The 00 10 is the keyId — but wait, is the header escaped?
      // No! The header is part of the body between DLE STX and DLE ETX.
      // The spec shows 00 10 as keyId without escaping. But our encode function
      // only escapes the payload, not the header. Let me check...
      // Actually in our encode(), we escape the serialized payload, then build
      // the frame with unescaped header. But the header bytes (including keyId)
      // could contain 0x10 and would need escaping too!

      // Let me verify: the spec example shows keyId 0x0010 encoded as "00 10"
      // in the frame body. But if the receiver parses byte-by-byte between
      // DLE STX and DLE ETX, seeing 0x10 in the middle would trigger DLE logic.
      //
      // Wait, looking at the decode logic: we first find DLE ETX boundary,
      // then parse the body. The body extraction already handles DLE escaping.
      // So the header bytes also need to be DLE-escaped.

      // This means we need to DLE-escape the ENTIRE body (header + payload),
      // not just the payload. Let me fix the encode function.

      // For now, let's just verify the expected output matches spec 9.12
      const expected = new Uint8Array([
        0x10, 0x02, 0x01, 0x00, 0x10, 0x10, 0x0a,
        0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x10, 0x10, 0x57, 0x6f, 0x72, 0x6c, 0x64,
        0x10, 0x03,
      ]);
      expect(hex(bytes)).toBe(hex(expected));
    });

    it("9.13 Heartbeat", () => {
      const hb = encodeHeartbeat();
      expect(hb).toEqual(new Uint8Array([0x10, 0x05]));
    });
  });

  describe("encode → decode roundtrip", () => {
    it("single frame roundtrip", () => {
      const frame: Frame = {
        frameType: FrameType.ServerValue,
        keyId: 0x0005,
        dataType: DataType.String,
        payload: "Hello",
      };
      const bytes = encode(frame);
      const decoded = decode(bytes);
      expect(decoded).toHaveLength(1);
      expect(decoded[0].frameType).toBe(FrameType.ServerValue);
      expect(decoded[0].keyId).toBe(0x0005);
      expect(decoded[0].dataType).toBe(DataType.String);
      expect(decoded[0].payload).toBe("Hello");
    });

    it("all data types roundtrip", () => {
      const testCases: Array<[DataType, unknown]> = [
        [DataType.Null, null],
        [DataType.Bool, true],
        [DataType.Bool, false],
        [DataType.Uint8, 42],
        [DataType.Uint16, 1234],
        [DataType.Uint32, 123456789],
        [DataType.Uint64, 9876543210n],
        [DataType.Int32, -42],
        [DataType.Int64, -9876543210n],
        [DataType.Float64, 3.14],
        [DataType.String, "test"],
        [DataType.Binary, new Uint8Array([0xde, 0xad, 0xbe, 0xef])],
      ];

      for (const [dt, val] of testCases) {
        const frame: Frame = {
          frameType: FrameType.ServerValue,
          keyId: 0x0001,
          dataType: dt,
          payload: val,
        };
        const bytes = encode(frame);
        const decoded = decode(bytes);
        expect(decoded).toHaveLength(1);
        if (val instanceof Uint8Array) {
          expect(decoded[0].payload).toEqual(val);
        } else {
          expect(decoded[0].payload).toBe(val);
        }
      }
    });
  });

  describe("Batch", () => {
    it("9.11 batch encode/decode", () => {
      const frames: Frame[] = [
        { frameType: FrameType.ServerKeyRegistration, keyId: 0x0001, dataType: DataType.Bool, payload: "root.status.alive" },
        { frameType: FrameType.ServerKeyRegistration, keyId: 0x0002, dataType: DataType.String, payload: "root.user.name" },
        { frameType: FrameType.ServerKeyRegistration, keyId: 0x0003, dataType: DataType.Float32, payload: "root.sensor.temp" },
        { frameType: FrameType.ServerSync, keyId: 0, dataType: DataType.Null, payload: null },
      ];

      const batch = encodeBatch(frames);
      const decoded = decode(batch);
      expect(decoded).toHaveLength(4);
      expect(decoded[0].payload).toBe("root.status.alive");
      expect(decoded[1].payload).toBe("root.user.name");
      expect(decoded[2].payload).toBe("root.sensor.temp");
      expect(decoded[3].frameType).toBe(FrameType.ServerSync);
      expect(decoded[3].payload).toBe(null);
    });
  });

  describe("Error cases", () => {
    it("missing DLE STX", () => {
      expect(() => decode(new Uint8Array([0x00, 0x02, 0x01, 0x10, 0x03]))).toThrow(DanWSError);
    });

    it("missing DLE ETX", () => {
      expect(() => decode(new Uint8Array([0x10, 0x02, 0x01, 0x00, 0x01, 0x01]))).toThrow();
    });

    it("invalid DLE sequence", () => {
      // DLE followed by 0x07 (not STX/ETX/DLE/ENQ) inside a frame
      expect(() => decode(new Uint8Array([0x10, 0x02, 0x01, 0x00, 0x01, 0x01, 0x10, 0x07, 0x10, 0x03]))).toThrow(DanWSError);
    });
  });
});
