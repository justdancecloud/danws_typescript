import { describe, it, expect } from "vitest";
import { serialize, deserialize } from "../../src/protocol/serializer.js";
import { DataType, DanWSError } from "../../src/protocol/types.js";

describe("Serializer", () => {
  describe("Null", () => {
    it("serialize produces 0 bytes", () => {
      expect(serialize(DataType.Null, null)).toEqual(new Uint8Array(0));
    });
    it("deserialize returns null", () => {
      expect(deserialize(DataType.Null, new Uint8Array(0))).toBe(null);
    });
  });

  describe("Bool", () => {
    it("roundtrip true", () => {
      const bytes = serialize(DataType.Bool, true);
      expect(bytes).toEqual(new Uint8Array([0x01]));
      expect(deserialize(DataType.Bool, bytes)).toBe(true);
    });
    it("roundtrip false", () => {
      const bytes = serialize(DataType.Bool, false);
      expect(bytes).toEqual(new Uint8Array([0x00]));
      expect(deserialize(DataType.Bool, bytes)).toBe(false);
    });
    it("rejects non-boolean", () => {
      expect(() => serialize(DataType.Bool, 1)).toThrow(DanWSError);
    });
    it("rejects invalid byte", () => {
      expect(() => deserialize(DataType.Bool, new Uint8Array([0x02]))).toThrow(DanWSError);
    });
  });

  describe("Uint8", () => {
    it("roundtrip 0", () => {
      const bytes = serialize(DataType.Uint8, 0);
      expect(deserialize(DataType.Uint8, bytes)).toBe(0);
    });
    it("roundtrip 255", () => {
      const bytes = serialize(DataType.Uint8, 255);
      expect(bytes).toEqual(new Uint8Array([0xff]));
      expect(deserialize(DataType.Uint8, bytes)).toBe(255);
    });
    it("rejects out of range", () => {
      expect(() => serialize(DataType.Uint8, 256)).toThrow(DanWSError);
      expect(() => serialize(DataType.Uint8, -1)).toThrow(DanWSError);
    });
  });

  describe("Uint16", () => {
    it("roundtrip 1000", () => {
      const bytes = serialize(DataType.Uint16, 1000);
      expect(bytes).toEqual(new Uint8Array([0x03, 0xe8])); // Big Endian
      expect(deserialize(DataType.Uint16, bytes)).toBe(1000);
    });
    it("roundtrip 65535", () => {
      const bytes = serialize(DataType.Uint16, 65535);
      expect(deserialize(DataType.Uint16, bytes)).toBe(65535);
    });
  });

  describe("Uint32", () => {
    it("roundtrip 1000", () => {
      const bytes = serialize(DataType.Uint32, 1000);
      expect(bytes).toEqual(new Uint8Array([0x00, 0x00, 0x03, 0xe8]));
      expect(deserialize(DataType.Uint32, bytes)).toBe(1000);
    });
    it("roundtrip max", () => {
      const bytes = serialize(DataType.Uint32, 0xffffffff);
      expect(deserialize(DataType.Uint32, bytes)).toBe(0xffffffff);
    });
  });

  describe("Uint64", () => {
    it("roundtrip", () => {
      const val = 1712345678000n;
      const bytes = serialize(DataType.Uint64, val);
      expect(bytes.length).toBe(8);
      expect(deserialize(DataType.Uint64, bytes)).toBe(val);
    });
    it("rejects number", () => {
      expect(() => serialize(DataType.Uint64, 123)).toThrow(DanWSError);
    });
  });

  describe("Int32", () => {
    it("roundtrip positive", () => {
      const bytes = serialize(DataType.Int32, 12345);
      expect(deserialize(DataType.Int32, bytes)).toBe(12345);
    });
    it("roundtrip negative", () => {
      const bytes = serialize(DataType.Int32, -12345);
      expect(deserialize(DataType.Int32, bytes)).toBe(-12345);
    });
    it("roundtrip min/max", () => {
      expect(deserialize(DataType.Int32, serialize(DataType.Int32, -2147483648))).toBe(-2147483648);
      expect(deserialize(DataType.Int32, serialize(DataType.Int32, 2147483647))).toBe(2147483647);
    });
  });

  describe("Int64", () => {
    it("roundtrip", () => {
      const val = -9876543210n;
      const bytes = serialize(DataType.Int64, val);
      expect(deserialize(DataType.Int64, bytes)).toBe(val);
    });
  });

  describe("Float32", () => {
    it("roundtrip 23.5", () => {
      const bytes = serialize(DataType.Float32, 23.5);
      // IEEE 754: 23.5 = 0x41BC0000
      expect(bytes).toEqual(new Uint8Array([0x41, 0xbc, 0x00, 0x00]));
      expect(deserialize(DataType.Float32, bytes)).toBe(23.5);
    });
    it("roundtrip -0.75", () => {
      const bytes = serialize(DataType.Float32, -0.75);
      // IEEE 754: -0.75 = 0xBF400000
      expect(bytes).toEqual(new Uint8Array([0xbf, 0x40, 0x00, 0x00]));
      expect(deserialize(DataType.Float32, bytes)).toBeCloseTo(-0.75);
    });
  });

  describe("Float64", () => {
    it("roundtrip", () => {
      const val = 3.141592653589793;
      const bytes = serialize(DataType.Float64, val);
      expect(bytes.length).toBe(8);
      expect(deserialize(DataType.Float64, bytes)).toBe(val);
    });
  });

  describe("String", () => {
    it("roundtrip ASCII", () => {
      const bytes = serialize(DataType.String, "Alice");
      expect(bytes).toEqual(new Uint8Array([0x41, 0x6c, 0x69, 0x63, 0x65]));
      expect(deserialize(DataType.String, bytes)).toBe("Alice");
    });
    it("roundtrip UTF-8", () => {
      const val = "Hello, \uD55C\uAD6D\uC5B4!";
      const bytes = serialize(DataType.String, val);
      expect(deserialize(DataType.String, bytes)).toBe(val);
    });
    it("roundtrip empty", () => {
      const bytes = serialize(DataType.String, "");
      expect(bytes.length).toBe(0);
      expect(deserialize(DataType.String, bytes)).toBe("");
    });
  });

  describe("Binary", () => {
    it("roundtrip", () => {
      const val = new Uint8Array([0x00, 0x10, 0xff, 0xab]);
      const bytes = serialize(DataType.Binary, val);
      expect(bytes).toEqual(val);
      const result = deserialize(DataType.Binary, bytes) as Uint8Array;
      expect(result).toEqual(val);
    });
  });

  describe("Timestamp", () => {
    it("roundtrip with Date", () => {
      const date = new Date("2026-04-06T12:00:00.000Z");
      const bytes = serialize(DataType.Timestamp, date);
      expect(bytes.length).toBe(8);
      const result = deserialize(DataType.Timestamp, bytes) as Date;
      expect(result.getTime()).toBe(date.getTime());
    });
    it("roundtrip with number", () => {
      const ms = 1743940800000;
      const bytes = serialize(DataType.Timestamp, ms);
      const result = deserialize(DataType.Timestamp, bytes) as Date;
      expect(result.getTime()).toBe(ms);
    });
  });

  describe("Payload size validation", () => {
    it("rejects wrong size for fixed types", () => {
      expect(() => deserialize(DataType.Bool, new Uint8Array([0x01, 0x02]))).toThrow(DanWSError);
      expect(() => deserialize(DataType.Uint32, new Uint8Array([0x01, 0x02, 0x03]))).toThrow(DanWSError);
      expect(() => deserialize(DataType.Float64, new Uint8Array(4))).toThrow(DanWSError);
    });
  });
});
