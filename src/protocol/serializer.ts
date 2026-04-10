import { DataType, DATA_TYPE_SIZES, DanWSError } from "./types.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

// Reusable buffer for numeric serialization — eliminates 2 of 3 allocations per numeric value
const _sharedBuf = new ArrayBuffer(8);
const _sharedView = new DataView(_sharedBuf);
const _sharedBytes = new Uint8Array(_sharedBuf);

export function serialize(dataType: DataType, value: unknown): Uint8Array {
  switch (dataType) {
    case DataType.Null:
      return new Uint8Array(0);

    case DataType.Bool: {
      if (typeof value !== "boolean") {
        throw new DanWSError("INVALID_VALUE_TYPE", `Bool requires boolean, got ${typeof value}`);
      }
      return new Uint8Array([value ? 0x01 : 0x00]);
    }

    case DataType.Uint8: {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) {
        throw new DanWSError("INVALID_VALUE_TYPE", `Uint8 requires integer 0-255, got ${value}`);
      }
      return new Uint8Array([value]);
    }

    case DataType.Uint16: {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffff) {
        throw new DanWSError("INVALID_VALUE_TYPE", `Uint16 requires integer 0-65535, got ${value}`);
      }
      _sharedView.setUint16(0, value, false);
      return new Uint8Array(_sharedBytes.buffer, 0, 2).slice();
    }

    case DataType.Uint32: {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
        throw new DanWSError("INVALID_VALUE_TYPE", `Uint32 requires integer 0-4294967295, got ${value}`);
      }
      _sharedView.setUint32(0, value, false);
      return new Uint8Array(_sharedBytes.buffer, 0, 4).slice();
    }

    case DataType.Uint64: {
      if (typeof value !== "bigint") {
        throw new DanWSError("INVALID_VALUE_TYPE", `Uint64 requires bigint, got ${typeof value}`);
      }
      if (value < 0n || value > 0xffffffffffffffffn) {
        throw new DanWSError("INVALID_VALUE_TYPE", `Uint64 out of range: ${value}`);
      }
      _sharedView.setBigUint64(0, value, false);
      return _sharedBytes.slice(0, 8);
    }

    case DataType.Int32: {
      if (typeof value !== "number" || !Number.isInteger(value) || value < -2147483648 || value > 2147483647) {
        throw new DanWSError("INVALID_VALUE_TYPE", `Int32 requires integer -2^31 to 2^31-1, got ${value}`);
      }
      _sharedView.setInt32(0, value, false);
      return _sharedBytes.slice(0, 4);
    }

    case DataType.Int64: {
      if (typeof value !== "bigint") {
        throw new DanWSError("INVALID_VALUE_TYPE", `Int64 requires bigint, got ${typeof value}`);
      }
      const min = -(1n << 63n);
      const max = (1n << 63n) - 1n;
      if (value < min || value > max) {
        throw new DanWSError("INVALID_VALUE_TYPE", `Int64 out of range: ${value}`);
      }
      _sharedView.setBigInt64(0, value, false);
      return _sharedBytes.slice(0, 8);
    }

    case DataType.Float32: {
      if (typeof value !== "number") {
        throw new DanWSError("INVALID_VALUE_TYPE", `Float32 requires number, got ${typeof value}`);
      }
      _sharedView.setFloat32(0, value, false);
      return _sharedBytes.slice(0, 4);
    }

    case DataType.Float64: {
      if (typeof value !== "number") {
        throw new DanWSError("INVALID_VALUE_TYPE", `Float64 requires number, got ${typeof value}`);
      }
      _sharedView.setFloat64(0, value, false);
      return _sharedBytes.slice(0, 8);
    }

    case DataType.String: {
      if (typeof value !== "string") {
        throw new DanWSError("INVALID_VALUE_TYPE", `String requires string, got ${typeof value}`);
      }
      return textEncoder.encode(value);
    }

    case DataType.Binary: {
      if (!(value instanceof Uint8Array)) {
        throw new DanWSError("INVALID_VALUE_TYPE", `Binary requires Uint8Array`);
      }
      return value;
    }

    case DataType.Timestamp: {
      let ms: bigint;
      if (value instanceof Date) {
        ms = BigInt(value.getTime());
      } else if (typeof value === "number") {
        ms = BigInt(value);
      } else {
        throw new DanWSError("INVALID_VALUE_TYPE", `Timestamp requires Date or number (unix ms)`);
      }
      _sharedView.setBigUint64(0, ms, false);
      return _sharedBytes.slice(0, 8);
    }

    case DataType.VarInteger: {
      if (typeof value !== "number") {
        throw new DanWSError("INVALID_VALUE_TYPE", `VarInteger requires number, got ${typeof value}`);
      }
      return serializeVarInteger(value as number);
    }

    case DataType.VarDouble: {
      if (typeof value !== "number") {
        throw new DanWSError("INVALID_VALUE_TYPE", `VarDouble requires number, got ${typeof value}`);
      }
      return serializeVarDouble(value);
    }

    case DataType.VarFloat: {
      // JS never produces VarFloat, but allow serialization for completeness
      if (typeof value !== "number") {
        throw new DanWSError("INVALID_VALUE_TYPE", `VarFloat requires number, got ${typeof value}`);
      }
      return serializeVarFloat(value);
    }

    default:
      throw new DanWSError("UNKNOWN_DATA_TYPE", `Unknown data type: 0x${(dataType as number).toString(16)}`);
  }
}

export function deserialize(dataType: DataType, payload: Uint8Array): unknown {
  const expectedSize = DATA_TYPE_SIZES[dataType];
  if (expectedSize >= 0 && payload.length !== expectedSize) {
    throw new DanWSError(
      "PAYLOAD_SIZE_MISMATCH",
      `${DataType[dataType]} expects ${expectedSize} bytes, got ${payload.length}`,
    );
  }

  const view = payload.length > 0 ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength) : null;

  switch (dataType) {
    case DataType.Null:
      return null;

    case DataType.Bool:
      if (payload[0] === 0x01) return true;
      if (payload[0] === 0x00) return false;
      throw new DanWSError("INVALID_VALUE_TYPE", `Bool payload must be 0x00 or 0x01, got 0x${payload[0].toString(16)}`);

    case DataType.Uint8:
      return payload[0];

    case DataType.Uint16:
      return view!.getUint16(0, false);

    case DataType.Uint32:
      return view!.getUint32(0, false);

    case DataType.Uint64:
      return view!.getBigUint64(0, false);

    case DataType.Int32:
      return view!.getInt32(0, false);

    case DataType.Int64:
      return view!.getBigInt64(0, false);

    case DataType.Float32:
      return view!.getFloat32(0, false);

    case DataType.Float64:
      return view!.getFloat64(0, false);

    case DataType.String:
      return textDecoder.decode(payload);

    case DataType.Binary:
      return new Uint8Array(payload);

    case DataType.Timestamp: {
      const ms = view!.getBigUint64(0, false);
      return new Date(Number(ms));
    }

    case DataType.VarInteger:
      return deserializeVarInteger(payload);

    case DataType.VarDouble:
      return deserializeVarDouble(payload);

    case DataType.VarFloat:
      return deserializeVarFloat(payload);

    default:
      throw new DanWSError("UNKNOWN_DATA_TYPE", `Unknown data type: 0x${(dataType as number).toString(16)}`);
  }
}

// --- Shared VarInt helpers ---

function encodeVarInt(value: number): Uint8Array {
  if (value === 0) return new Uint8Array([0]);
  const bytes: number[] = [];
  while (value > 0) {
    let byte = value & 0x7F;
    value = Math.floor(value / 128);
    if (value > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return new Uint8Array(bytes);
}

function decodeVarIntFromPayload(payload: Uint8Array, offset: number = 0): number {
  // Running multiplier avoids Math.pow call per byte and keeps values beyond
  // 2^31 accurate (JS bitwise ops are 32-bit signed, so `<<` would wrap).
  let value = 0;
  let multiplier = 1;
  let i = offset;
  while (i < payload.length) {
    const byte = payload[i];
    value += (byte & 0x7F) * multiplier;
    multiplier *= 128;
    i++;
    if ((byte & 0x80) === 0) break;
  }
  return value;
}

// --- VarInteger (0x0d) helpers ---

function serializeVarInteger(value: number): Uint8Array {
  // Zigzag encode: maps signed to unsigned
  // 0->0, -1->1, 1->2, -2->3, 2->4, ...
  const zigzag = value >= 0 ? value * 2 : (-value) * 2 - 1;
  return encodeVarInt(zigzag);
}

function deserializeVarInteger(payload: Uint8Array): number {
  if (payload.length === 0) {
    throw new DanWSError("PAYLOAD_SIZE_MISMATCH", "VarInteger requires at least 1 byte");
  }
  const zigzag = decodeVarIntFromPayload(payload);
  // Zigzag decode: (zigzag >>> 1) ^ -(zigzag & 1)
  const n = (zigzag & 1) ? -Math.floor(zigzag / 2) - 1 : Math.floor(zigzag / 2);
  return n;
}

// --- VarDouble (0x0e) helpers ---

function fallbackFloat64(value: number): Uint8Array {
  const result = new Uint8Array(9);
  result[0] = 0x80;
  const view = new DataView(result.buffer, 1, 8);
  view.setFloat64(0, value, false);
  return result;
}

function serializeVarDouble(value: number): Uint8Array {
  // Fallback cases: NaN, Infinity, -Infinity, -0, or unrepresentable
  if (!Number.isFinite(value) || Object.is(value, -0)) {
    return fallbackFloat64(value);
  }

  // Determine scale via string representation (avoids floating-point drift)
  const abs = Math.abs(value);
  let scale = 0;
  let mantissa = abs;
  const str = abs.toString();
  const dotIdx = str.indexOf(".");
  if (dotIdx !== -1) {
    // Check for scientific notation (e.g. 1e-7)
    if (str.includes("e") || str.includes("E")) {
      return fallbackFloat64(value);
    }
    scale = str.length - dotIdx - 1;
    if (scale > 63) return fallbackFloat64(value);
    mantissa = Number(str.replace(".", ""));
  }

  // If mantissa exceeds safe integer, fallback
  if (!Number.isFinite(mantissa) || mantissa > Number.MAX_SAFE_INTEGER) {
    return fallbackFloat64(value);
  }

  const negative = value < 0;
  const firstByte = negative ? (scale + 64) : scale;
  const varint = encodeVarInt(mantissa);
  const result = new Uint8Array(1 + varint.length);
  result[0] = firstByte;
  result.set(varint, 1);
  return result;
}

function deserializeVarDouble(payload: Uint8Array): number {
  if (payload.length === 0) {
    throw new DanWSError("PAYLOAD_SIZE_MISMATCH", "VarDouble requires at least 1 byte");
  }

  const firstByte = payload[0];

  if (firstByte === 0x80) {
    // Fallback Float64
    if (payload.length < 9) {
      throw new DanWSError("PAYLOAD_SIZE_MISMATCH", "VarDouble fallback requires 9 bytes");
    }
    const view = new DataView(payload.buffer, payload.byteOffset + 1, 8);
    return view.getFloat64(0, false);
  }

  const negative = firstByte >= 64;
  const scale = negative ? (firstByte - 64) : firstByte;

  const mantissa = decodeVarIntFromPayload(payload, 1);

  let result = mantissa / Math.pow(10, scale);
  if (negative) result = -result;
  return result;
}

// --- VarFloat (0x0f) helpers ---

function fallbackFloat32(value: number): Uint8Array {
  const result = new Uint8Array(5);
  result[0] = 0x80;
  const view = new DataView(result.buffer, 1, 4);
  view.setFloat32(0, value, false);
  return result;
}

function serializeVarFloat(value: number): Uint8Array {
  // Same as VarDouble but fallback uses Float32 instead of Float64
  if (!Number.isFinite(value) || Object.is(value, -0)) {
    return fallbackFloat32(value);
  }

  const abs = Math.abs(value);
  let scale = 0;
  let mantissa = abs;
  const str = abs.toString();
  const dotIdx = str.indexOf(".");
  if (dotIdx !== -1) {
    if (str.includes("e") || str.includes("E")) {
      return fallbackFloat32(value);
    }
    scale = str.length - dotIdx - 1;
    if (scale > 63) return fallbackFloat32(value);
    mantissa = Number(str.replace(".", ""));
  }

  if (!Number.isFinite(mantissa) || mantissa > Number.MAX_SAFE_INTEGER) {
    return fallbackFloat32(value);
  }

  const negative = value < 0;
  const firstByte = negative ? (scale + 64) : scale;
  const varint = encodeVarInt(mantissa);
  const result = new Uint8Array(1 + varint.length);
  result[0] = firstByte;
  result.set(varint, 1);
  return result;
}

function deserializeVarFloat(payload: Uint8Array): number {
  if (payload.length === 0) {
    throw new DanWSError("PAYLOAD_SIZE_MISMATCH", "VarFloat requires at least 1 byte");
  }

  const firstByte = payload[0];

  if (firstByte === 0x80) {
    // Fallback Float32 (4 bytes instead of 8)
    if (payload.length < 5) {
      throw new DanWSError("PAYLOAD_SIZE_MISMATCH", "VarFloat fallback requires 5 bytes");
    }
    const view = new DataView(payload.buffer, payload.byteOffset + 1, 4);
    return view.getFloat32(0, false);
  }

  const negative = firstByte >= 64;
  const scale = negative ? (firstByte - 64) : firstByte;

  const mantissa = decodeVarIntFromPayload(payload, 1);

  let result = mantissa / Math.pow(10, scale);
  if (negative) result = -result;
  return result;
}
