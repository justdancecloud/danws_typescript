import { DataType, FrameType, DanWSError } from "../protocol/types.js";
import type { Frame } from "../protocol/types.js";
import { serialize } from "../protocol/serializer.js";
import { detectDataType } from "../protocol/auto-type.js";
import { validateKeyPath } from "../state/key-registry.js";
import { flattenValue, shouldFlatten } from "./flatten.js";
import { detectArrayShiftBoth, isArrayIndexKey, applyArrayShiftLeft, applyArrayShiftRight, type ArrayShiftContext } from "./array-diff.js";

interface FlatEntry {
  keyId: number;
  type: DataType;
  value: unknown;
}

export interface FlatStateCallbacks {
  allocateKeyId(): number;
  enqueue(frame: Frame): void;
  onResync(): void;
  /** Wire path prefix for key registration (e.g. "t.0." for topics, "" for flat). */
  wirePrefix: string;
  /** If provided, new keys send 3 incremental frames instead of triggering resync. */
  onIncrementalKey?: (keyFrame: Frame, syncFrame: Frame, valueFrame: Frame) => void;
  /** Called when cachedKeyFrames should be invalidated. */
  onKeyStructureChange?: () => void;
  /** Max serialized value size in bytes. Throws VALUE_TOO_LARGE if exceeded. */
  maxValueSize?: number;
}

/**
 * Shared flatten + shift + diff + setLeaf logic.
 * Used by PrincipalTX, DanWebSocketSession, and TopicPayload via composition.
 */
export class FlatStateManager {
  private _entries = new Map<string, FlatEntry>();
  private _flattenedKeys = new Map<string, Set<string>>();
  private _previousArrays = new Map<string, unknown[]>();
  private _cb: FlatStateCallbacks;
  private _freedKeyIds: number[] = [];

  constructor(cb: FlatStateCallbacks) {
    this._cb = cb;
  }

  private _allocateKeyId(): number {
    return this._freedKeyIds.length > 0 ? this._freedKeyIds.pop()! : this._cb.allocateKeyId();
  }

  private _freeKeyId(keyId: number): void {
    // Cap pool size to prevent unbounded growth (pool never needs to be larger than active key count)
    if (this._freedKeyIds.length < 10_000) {
      this._freedKeyIds.push(keyId);
    }
  }

  set(key: string, value: unknown): void {
    if (shouldFlatten(value)) {
      if (Array.isArray(value)) {
        const oldArr = this._previousArrays.get(key);
        const hasPrimitiveElements = value.length === 0 || !shouldFlatten(value[0]);
        if (hasPrimitiveElements && oldArr && oldArr.length > 0 && value.length > 0) {
          const shift = detectArrayShiftBoth(oldArr, value);
          if (shift.direction !== "none") {
            const ctx = this._buildShiftContext();
            if (shift.direction === "left") {
              applyArrayShiftLeft(ctx, key, oldArr, value, shift.count);
              return;
            }
            if (shift.direction === "right") {
              applyArrayShiftRight(ctx, key, oldArr, value, shift.count);
              return;
            }
          }
        }
        this._previousArrays.set(key, [...value]);
      }

      const flattened = flattenValue(key, value);
      const newKeys = new Set(flattened.keys());
      const oldKeys = this._flattenedKeys.get(key);
      let structureChanged = false;
      if (oldKeys) {
        for (const oldPath of oldKeys) {
          if (!newKeys.has(oldPath)) {
            if (isArrayIndexKey(key, oldPath)) continue;
            const entry = this._entries.get(oldPath);
            if (entry) {
              this._cb.enqueue({ frameType: FrameType.ServerKeyDelete, keyId: entry.keyId, dataType: DataType.Null, payload: null });
              this._freeKeyId(entry.keyId);
              this._entries.delete(oldPath);
              structureChanged = true;
            }
          }
        }
      }
      this._flattenedKeys.set(key, newKeys);
      for (const [path, leaf] of flattened) {
        this._setLeaf(path, leaf);
      }
      if (structureChanged) this._cb.onKeyStructureChange?.();
      return;
    }
    if (this._setLeaf(key, value)) this._cb.onResync();
  }

  get(key: string): unknown {
    const entry = this._entries.get(key);
    return entry ? entry.value : undefined;
  }

  get keys(): string[] {
    return Array.from(this._entries.keys());
  }

  get size(): number {
    return this._entries.size;
  }

  clear(key?: string): void {
    if (key !== undefined) {
      const flatKeys = this._flattenedKeys.get(key);
      if (flatKeys) {
        for (const path of flatKeys) {
          const entry = this._entries.get(path);
          if (entry) {
            this._cb.enqueue({ frameType: FrameType.ServerKeyDelete, keyId: entry.keyId, dataType: DataType.Null, payload: null });
            this._freeKeyId(entry.keyId);
            this._entries.delete(path);
          }
        }
        this._flattenedKeys.delete(key);
        this._previousArrays.delete(key);
        this._cb.onKeyStructureChange?.();
      } else {
        const entry = this._entries.get(key);
        if (entry) {
          this._cb.enqueue({ frameType: FrameType.ServerKeyDelete, keyId: entry.keyId, dataType: DataType.Null, payload: null });
          this._freeKeyId(entry.keyId);
          this._entries.delete(key);
          this._previousArrays.delete(key);
          this._cb.onKeyStructureChange?.();
        }
      }
    } else {
      // clear() with no args — full reset, reclaim all keyIds
      if (this._entries.size > 0) {
        for (const entry of this._entries.values()) {
          this._freedKeyIds.push(entry.keyId);
        }
        this._entries.clear();
        this._flattenedKeys.clear();
        this._previousArrays.clear();
        this._cb.onKeyStructureChange?.();
        this._cb.onResync();
      }
    }
  }

  buildKeyFrames(): Frame[] {
    const frames: Frame[] = [];
    for (const [key, entry] of this._entries) {
      const wirePath = this._cb.wirePrefix ? `${this._cb.wirePrefix}${key}` : key;
      frames.push({
        frameType: FrameType.ServerKeyRegistration,
        keyId: entry.keyId,
        dataType: entry.type,
        payload: wirePath,
      });
    }
    return frames;
  }

  buildValueFrames(): Frame[] {
    const frames: Frame[] = [];
    for (const entry of this._entries.values()) {
      if (entry.value !== undefined) {
        frames.push({
          frameType: FrameType.ServerValue,
          keyId: entry.keyId,
          dataType: entry.type,
          payload: entry.value,
        });
      }
    }
    return frames;
  }

  /** Returns true if resync is needed (type change on existing key). */
  private _setLeaf(key: string, value: unknown): boolean {
    validateKeyPath(key);
    const newType = detectDataType(value);

    const existing = this._entries.get(key);

    // Fast path: skip serialization entirely when value is identical
    if (existing) {
      if (existing.value === value) return false;

      // Only serialize for size check when maxValueSize is configured
      if (this._cb.maxValueSize != null) {
        const serialized = serialize(newType, value);
        if (serialized.length > this._cb.maxValueSize) {
          throw new DanWSError("VALUE_TOO_LARGE", `Serialized value for "${key}" is ${serialized.length} bytes, exceeds maxValueSize (${this._cb.maxValueSize})`);
        }
      }

      if (existing.type !== newType) {
        // Type changed — delete old key, register new key (incremental, no full resync)
        this._cb.enqueue({ frameType: FrameType.ServerKeyDelete, keyId: existing.keyId, dataType: DataType.Null, payload: null });
        this._freeKeyId(existing.keyId);
        this._entries.delete(key);
        this._cb.onKeyStructureChange?.();
        // Re-register with new keyId + type (may reuse the freed keyId)
        const newKeyId = this._allocateKeyId();
        this._entries.set(key, { keyId: newKeyId, type: newType, value });
        const wirePath = this._cb.wirePrefix ? `${this._cb.wirePrefix}${key}` : key;
        this._cb.enqueue({ frameType: FrameType.ServerKeyRegistration, keyId: newKeyId, dataType: newType, payload: wirePath });
        this._cb.enqueue({ frameType: FrameType.ServerSync, keyId: 0, dataType: DataType.Null, payload: null });
        this._cb.enqueue({ frameType: FrameType.ServerValue, keyId: newKeyId, dataType: newType, payload: value });
        return false;
      }

      existing.value = value;
      this._cb.enqueue({
        frameType: FrameType.ServerValue,
        keyId: existing.keyId,
        dataType: existing.type,
        payload: value,
      });
      return false;
    }

    // New key — serialize for size check only when maxValueSize is configured
    if (this._cb.maxValueSize != null) {
      const serialized = serialize(newType, value);
      if (serialized.length > this._cb.maxValueSize) {
        throw new DanWSError("VALUE_TOO_LARGE", `Serialized value for "${key}" is ${serialized.length} bytes, exceeds maxValueSize (${this._cb.maxValueSize})`);
      }
    }

    const keyId = this._allocateKeyId();
    this._entries.set(key, { keyId, type: newType, value });
    this._cb.onKeyStructureChange?.();
    const wirePath = this._cb.wirePrefix ? `${this._cb.wirePrefix}${key}` : key;
    const keyFrame: Frame = { frameType: FrameType.ServerKeyRegistration, keyId, dataType: newType, payload: wirePath };
    const syncFrame: Frame = { frameType: FrameType.ServerSync, keyId: 0, dataType: DataType.Null, payload: null };
    const valueFrame: Frame = { frameType: FrameType.ServerValue, keyId, dataType: newType, payload: value };
    if (this._cb.onIncrementalKey) {
      this._cb.onIncrementalKey(keyFrame, syncFrame, valueFrame);
    } else {
      this._cb.enqueue(keyFrame);
      this._cb.enqueue(syncFrame);
      this._cb.enqueue(valueFrame);
    }
    return false;
  }

  private _buildShiftContext(): ArrayShiftContext {
    return {
      getEntry: (key) => this._entries.get(key),
      setEntryValue: (key, value) => { const e = this._entries.get(key); if (e) e.value = value; },
      setLeaf: (key, value) => this._setLeaf(key, value),
      enqueue: (frame) => this._cb.enqueue(frame),
      setFlattenedKeys: (key, keys) => this._flattenedKeys.set(key, keys),
      setPreviousArray: (key, arr) => this._previousArrays.set(key, arr),
    };
  }
}
