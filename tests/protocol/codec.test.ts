import { describe, it, expect } from "vitest";
import { encode, decode, encodeBatch, encodeHeartbeat } from "../../src/protocol/codec.js";
import { DataType, FrameType, DanWSError } from "../../src/protocol/types.js";
import type { Frame } from "../../src/protocol/types.js";

function hex(arr: Uint8Array): string {
  return Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join(" ");
}

describe("Codec", () => {
  // Frame body: [FrameType:1][KeyID:4][DataType:1][Payload:N]
  describe("Wire Examples — 4-byte KeyID", () => {
    it("9.1 Server Key Registration — root.status.alive, bool, keyId 0x0001", () => {
      const frame: Frame = {
        frameType: FrameType.ServerKeyRegistration,
        keyId: 0x0001,
        dataType: DataType.Bool,
        payload: "root.status.alive",
      };
      const bytes = encode(frame);
      // DLE STX | FT=0x00 KeyID=0x00000001 DT=0x01 | payload | DLE ETX
      const expected = new Uint8Array([
        0x10, 0x02,
        0x00, 0x00, 0x00, 0x00, 0x01, 0x01,
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
      // DLE STX | FT=0x01 KeyID=0x00000001 DT=0x01 | 0x01 | DLE ETX
      const expected = new Uint8Array([0x10, 0x02, 0x01, 0x00, 0x00, 0x00, 0x01, 0x01, 0x01, 0x10, 0x03]);
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
        0x10, 0x02, 0x01, 0x00, 0x00, 0x00, 0x02, 0x0a,
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
        0x10, 0x02, 0x01, 0x00, 0x00, 0x00, 0x03, 0x04,
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
        0x10, 0x02, 0x01, 0x00, 0x00, 0x00, 0x04, 0x08,
        0x41, 0xbc, 0x00, 0x00,
        0x10, 0x03,
      ]);
      expect(hex(bytes)).toBe(hex(expected));
    });

    it("9.7 Signal frames", () => {
      // Signal: [DLE STX] [FT] [0x00 0x00 0x00 0x00] [0x00] [DLE ETX]
      const signals: Array<[FrameType, number[]]> = [
        [FrameType.ServerSync, [0x10, 0x02, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x03]],
        [FrameType.ClientReady, [0x10, 0x02, 0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x03]],
        [FrameType.ClientSync, [0x10, 0x02, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x03]],
        [FrameType.ServerReady, [0x10, 0x02, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x03]],
        [FrameType.ServerReset, [0x10, 0x02, 0x09, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x03]],
        [FrameType.ClientResyncReq, [0x10, 0x02, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x03]],
        [FrameType.AuthOk, [0x10, 0x02, 0x0f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x03]],
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
        0x10, 0x02, 0x02, 0x00, 0x00, 0x00, 0x01, 0x08,
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
        0x10, 0x02, 0x03, 0x00, 0x00, 0x00, 0x01, 0x08,
        0xbf, 0x40, 0x00, 0x00,
        0x10, 0x03,
      ]);
      expect(hex(valBytes)).toBe(hex(expectedVal));
    });

    it("9.12 DLE escaping in frame — keyId with 0x10 byte", () => {
      // keyId 0x0010 → bytes 0x00 0x00 0x00 0x10 → DLE-escaped to 0x00 0x00 0x00 0x10 0x10
      const frame: Frame = {
        frameType: FrameType.ServerValue,
        keyId: 0x0010,
        dataType: DataType.String,
        payload: "Hello\x10World",
      };
      const bytes = encode(frame);
      const expected = new Uint8Array([
        0x10, 0x02,
        0x01, 0x00, 0x00, 0x00, 0x10, 0x10, 0x0a, // FT=0x01, KeyID=0x00000010 (0x10 escaped), DT=0x0a
        0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x10, 0x10, 0x57, 0x6f, 0x72, 0x6c, 0x64, // "Hello\x10World" escaped
        0x10, 0x03,
      ]);
      expect(hex(bytes)).toBe(hex(expected));
    });

    it("9.13 Heartbeat", () => {
      const hb = encodeHeartbeat();
      expect(hb).toEqual(new Uint8Array([0x10, 0x05]));
    });

    it("large keyId (4-byte range)", () => {
      const frame: Frame = {
        frameType: FrameType.ServerValue,
        keyId: 0x00ABCDEF,
        dataType: DataType.Bool,
        payload: true,
      };
      const bytes = encode(frame);
      const decoded = decode(bytes);
      expect(decoded[0].keyId).toBe(0x00ABCDEF);
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

    it("keyId with DLE byte roundtrip", () => {
      const frame: Frame = {
        frameType: FrameType.ServerValue,
        keyId: 0x10101010,
        dataType: DataType.Bool,
        payload: true,
      };
      const bytes = encode(frame);
      const decoded = decode(bytes);
      expect(decoded[0].keyId).toBe(0x10101010);
      expect(decoded[0].payload).toBe(true);
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
      expect(() => decode(new Uint8Array([0x00, 0x02, 0x01, 0x00, 0x00, 0x00, 0x01, 0x10, 0x03]))).toThrow(DanWSError);
    });

    it("missing DLE ETX", () => {
      expect(() => decode(new Uint8Array([0x10, 0x02, 0x01, 0x00, 0x00, 0x00, 0x01, 0x01]))).toThrow();
    });

    it("invalid DLE sequence", () => {
      expect(() => decode(new Uint8Array([0x10, 0x02, 0x01, 0x00, 0x00, 0x00, 0x01, 0x01, 0x10, 0x07, 0x10, 0x03]))).toThrow(DanWSError);
    });
  });
});
