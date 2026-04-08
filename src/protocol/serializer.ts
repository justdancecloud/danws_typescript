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

    default:
      throw new DanWSError("UNKNOWN_DATA_TYPE", `Unknown data type: 0x${(dataType as number).toString(16)}`);
  }
}
