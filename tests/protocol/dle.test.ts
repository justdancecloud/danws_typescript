import { describe, it, expect } from "vitest";
import { dleEncode, dleDecode } from "../../src/protocol/dle.js";

describe("DLE Escaping", () => {
  it("no DLE bytes — passthrough", () => {
    const input = new Uint8Array([0x41, 0x42, 0x43]);
    expect(dleEncode(input)).toEqual(input);
    expect(dleDecode(input)).toEqual(input);
  });

  it("single DLE byte", () => {
    // Example 1 from spec: 48 10 65 6C 6C → 48 10 10 65 6C 6C
    const original = new Uint8Array([0x48, 0x10, 0x65, 0x6c, 0x6c]);
    const encoded = dleEncode(original);
    expect(encoded).toEqual(new Uint8Array([0x48, 0x10, 0x10, 0x65, 0x6c, 0x6c]));
    expect(dleDecode(encoded)).toEqual(original);
  });

  it("payload contains 0x10 0x02 (looks like DLE STX)", () => {
    // Example 2: AA 10 02 BB → AA 10 10 02 BB
    const original = new Uint8Array([0xaa, 0x10, 0x02, 0xbb]);
    const encoded = dleEncode(original);
    expect(encoded).toEqual(new Uint8Array([0xaa, 0x10, 0x10, 0x02, 0xbb]));
    expect(dleDecode(encoded)).toEqual(original);
  });

  it("payload contains 0x10 0x03 (looks like DLE ETX)", () => {
    // Example 3: CC 10 03 DD → CC 10 10 03 DD
    const original = new Uint8Array([0xcc, 0x10, 0x03, 0xdd]);
    const encoded = dleEncode(original);
    expect(encoded).toEqual(new Uint8Array([0xcc, 0x10, 0x10, 0x03, 0xdd]));
    expect(dleDecode(encoded)).toEqual(original);
  });

  it("consecutive DLE bytes", () => {
    // Example 4: FF 10 10 EE → FF 10 10 10 10 EE
    const original = new Uint8Array([0xff, 0x10, 0x10, 0xee]);
    const encoded = dleEncode(original);
    expect(encoded).toEqual(new Uint8Array([0xff, 0x10, 0x10, 0x10, 0x10, 0xee]));
    expect(dleDecode(encoded)).toEqual(original);
  });

  it("all DLE bytes", () => {
    const original = new Uint8Array([0x10, 0x10, 0x10]);
    const encoded = dleEncode(original);
    expect(encoded).toEqual(new Uint8Array([0x10, 0x10, 0x10, 0x10, 0x10, 0x10]));
    expect(dleDecode(encoded)).toEqual(original);
  });

  it("empty payload", () => {
    const original = new Uint8Array(0);
    expect(dleEncode(original)).toEqual(original);
    expect(dleDecode(original)).toEqual(original);
  });
});
