import { DataType } from "./types.js";

/**
 * Auto-detect DataType from a JavaScript value.
 */
export function detectDataType(value: unknown): DataType {
  if (value === null || value === undefined) return DataType.Null;
  if (typeof value === "boolean") return DataType.Bool;
  if (typeof value === "bigint") return value >= 0n ? DataType.Uint64 : DataType.Int64;
  if (typeof value === "number") return Number.isInteger(value) ? DataType.VarInteger : DataType.VarDouble;
  if (typeof value === "string") return DataType.String;
  if (value instanceof Uint8Array) return DataType.Binary;
  if (value instanceof Date) return DataType.Timestamp;

  throw new Error(`Cannot detect DataType for value: ${value}`);
}
