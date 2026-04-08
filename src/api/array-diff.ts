import { DataType, FrameType } from "../protocol/types.js";
import type { Frame } from "../protocol/types.js";
import { flattenValue, shouldFlatten } from "./flatten.js";

export interface ShiftResult {
  direction: "left" | "right" | "none";
  count: number;
}

/**
 * Detect left or right shift between old and new arrays.
 * Left shift: old[k:] matches new[0:matchLen]
 * Right shift: old[0:matchLen] matches new[k:k+matchLen]
 */
export function detectArrayShiftBoth(oldArr: unknown[], newArr: unknown[]): ShiftResult {
  const oldLen = oldArr.length;
  const newLen = newArr.length;

  // Cap shift search to avoid O(n^2) on large arrays
  const MAX_SHIFT = 50;

  // 1. Left shift: find new[0] in oldArr → gives shift amount k
  const newFirst = newArr[0];
  const leftLimit = Math.min(oldLen, MAX_SHIFT + 1);
  for (let k = 1; k < leftLimit; k++) {
    if (oldArr[k] !== newFirst) continue;
    const matchLen = Math.min(oldLen - k, newLen);
    if (matchLen <= 0) continue;
    let match = true;
    for (let i = 1; i < matchLen; i++) {
      if (oldArr[i + k] !== newArr[i]) { match = false; break; }
    }
    if (match) return { direction: "left", count: k };
  }

  // 2. Right shift: find old[0] in newArr → gives shift amount k
  const oldFirst = oldArr[0];
  const rightLimit = Math.min(newLen, MAX_SHIFT + 1);
  for (let k = 1; k < rightLimit; k++) {
    if (newArr[k] !== oldFirst) continue;
    const matchLen = Math.min(oldLen, newLen - k);
    if (matchLen <= 0) continue;
    let match = true;
    for (let i = 1; i < matchLen; i++) {
      if (oldArr[i] !== newArr[i + k]) { match = false; break; }
    }
    if (match) return { direction: "right", count: k };
  }

  return { direction: "none", count: 0 };
}

/**
 * Check if a path is a numeric array index under a given prefix.
 * e.g. isArrayIndexKey("data", "data.3") → true
 *      isArrayIndexKey("data", "data.length") → false
 */
export function isArrayIndexKey(prefix: string, path: string): boolean {
  if (!path.startsWith(prefix + '.')) return false;
  const suffix = path.slice(prefix.length + 1);
  return suffix.length > 0 && /^\d+$/.test(suffix);
}

/** Context for applying array shift operations. */
export interface ArrayShiftContext {
  /** Get an entry by key path. Returns { keyId, type, value } or undefined. */
  getEntry(key: string): { keyId: number; type: DataType; value: unknown } | undefined;
  /** Set an entry's value (silently, no frame). */
  setEntryValue(key: string, value: unknown): void;
  /** Set a leaf key-value (sends frame if changed, creates if new). */
  setLeaf(key: string, value: unknown): void;
  /** Enqueue a frame for sending. */
  enqueue(frame: Frame): void;
  /** Update the flattenedKeys set for a prefix. */
  setFlattenedKeys(key: string, keys: Set<string>): void;
  /** Update the previousArrays cache. */
  setPreviousArray(key: string, arr: unknown[]): void;
}

export function applyArrayShiftLeft(
  ctx: ArrayShiftContext,
  key: string,
  oldArr: unknown[],
  newArr: unknown[],
  shiftCount: number,
): void {
  const oldLen = oldArr.length;
  const newLen = newArr.length;

  // 1. Send ARRAY_SHIFT_LEFT frame
  const lengthEntry = ctx.getEntry(key + ".length");
  if (lengthEntry) {
    ctx.enqueue({
      frameType: FrameType.ArrayShiftLeft,
      keyId: lengthEntry.keyId,
      dataType: DataType.Int32,
      payload: shiftCount,
    });
  }

  // 2. Silently update internal store for shifted indices (low to high)
  for (let i = 0; i < newLen && i < oldLen - shiftCount; i++) {
    ctx.setEntryValue(`${key}.${i}`, newArr[i]);
  }

  // 3. Send new tail elements
  const existingAfterShift = oldLen - shiftCount;
  for (let i = existingAfterShift; i < newLen; i++) {
    const elem = newArr[i];
    if (shouldFlatten(elem)) {
      const elemFlat = flattenValue(`${key}.${i}`, elem);
      for (const [path, leaf] of elemFlat) ctx.setLeaf(path, leaf);
    } else {
      ctx.setLeaf(`${key}.${i}`, elem);
    }
  }

  // 4. Always send length — client decrements length on ArrayShiftLeft,
  //    so we must send the correct final length to restore it.
  const lenEntry = ctx.getEntry(key + ".length");
  if (lenEntry) {
    ctx.setEntryValue(key + ".length", newLen);
    ctx.enqueue({
      frameType: FrameType.ServerValue,
      keyId: lenEntry.keyId,
      dataType: lenEntry.type,
      payload: newLen,
    });
  }

  // 5. Update flattenedKeys + previousArrays
  const flattened = flattenValue(key, newArr);
  ctx.setFlattenedKeys(key, new Set(flattened.keys()));
  ctx.setPreviousArray(key, [...newArr]);
}

export function applyArrayShiftRight(
  ctx: ArrayShiftContext,
  key: string,
  oldArr: unknown[],
  newArr: unknown[],
  shiftCount: number,
): void {
  const oldLen = oldArr.length;
  const newLen = newArr.length;

  // 1. Send ARRAY_SHIFT_RIGHT frame
  const lengthEntry = ctx.getEntry(key + ".length");
  if (lengthEntry) {
    ctx.enqueue({
      frameType: FrameType.ArrayShiftRight,
      keyId: lengthEntry.keyId,
      dataType: DataType.Int32,
      payload: shiftCount,
    });
  }

  // 2. Silently update internal store for shifted indices (high to low)
  for (let i = oldLen - 1; i >= 0; i--) {
    const dstKey = `${key}.${i + shiftCount}`;
    if (ctx.getEntry(dstKey)) {
      ctx.setEntryValue(dstKey, oldArr[i]);
    }
  }

  // 3. Send new head elements (indices 0..shiftCount-1)
  for (let i = 0; i < shiftCount; i++) {
    const elem = newArr[i];
    if (shouldFlatten(elem)) {
      const elemFlat = flattenValue(`${key}.${i}`, elem);
      for (const [path, leaf] of elemFlat) ctx.setLeaf(path, leaf);
    } else {
      ctx.setLeaf(`${key}.${i}`, elem);
    }
  }

  // 3b. Send overflow tail elements (old elements shifted beyond old bounds)
  for (let i = oldLen; i < newLen; i++) {
    const elem = newArr[i];
    if (shouldFlatten(elem)) {
      const elemFlat = flattenValue(`${key}.${i}`, elem);
      for (const [path, leaf] of elemFlat) ctx.setLeaf(path, leaf);
    } else {
      ctx.setLeaf(`${key}.${i}`, elem);
    }
  }

  // 4. Update length if changed
  if (newLen !== oldLen) {
    ctx.setLeaf(key + ".length", newLen);
  }

  // 5. Update flattenedKeys + previousArrays
  const flattened = flattenValue(key, newArr);
  ctx.setFlattenedKeys(key, new Set(flattened.keys()));
  ctx.setPreviousArray(key, [...newArr]);
}
