import { DataType, FrameType, DanWSError } from "../protocol/types.js";
import type { Frame } from "../protocol/types.js";
import { serialize } from "../protocol/serializer.js";
import { detectDataType } from "../protocol/auto-type.js";
import { validateKeyPath } from "../state/key-registry.js";
import { flattenValue, shouldFlatten } from "./flatten.js";
import { detectArrayShiftBoth, isArrayIndexKey, applyArrayShiftLeft, applyArrayShiftRight, type ArrayShiftContext } from "./array-diff.js";

interface KeyEntry {
  keyId: number;
  path: string;
  type: DataType;
  value: unknown;
}

/**
 * Shared TX state for one principal.
 * All sessions of the same principal share this state.
 */
export class PrincipalTX {
  readonly name: string;
  private _entries = new Map<string, KeyEntry>(); // path → entry
  private _nextKeyId = 1;
  private _needsResync = false;
  private _onValueSet: ((frame: Frame) => void) | null = null;
  private _onKeysChanged: (() => void) | null = null;
  private _onIncrementalKey: ((keyFrame: Frame, syncFrame: Frame, valueFrame: Frame) => void) | null = null;
  private _flattenedKeys = new Map<string, Set<string>>(); // prefix → set of flattened paths
  private _cachedKeyFrames: Frame[] | null = null;
  private _previousArrays = new Map<string, unknown[]>(); // key → previous array values

  constructor(name: string) {
    this.name = name;
  }

  /** @internal */
  _onValue(fn: (frame: Frame) => void): void {
    this._onValueSet = fn;
  }

  /** @internal */
  _onResync(fn: () => void): void {
    this._onKeysChanged = fn;
  }

  /** @internal — incremental key addition (avoids full resync) */
  _onIncremental(fn: (keyFrame: Frame, syncFrame: Frame, valueFrame: Frame) => void): void {
    this._onIncrementalKey = fn;
  }

  /**
   * Set a key-value pair. Auto-detects DataType from the value.
   * If the key is new or its type changes, triggers re-sync to all sessions.
   */
  set(key: string, value: unknown): void {
    if (shouldFlatten(value)) {
      // Array shift detection for array values
      if (Array.isArray(value)) {
        const oldArr = this._previousArrays.get(key);
        // Only use shift optimization for arrays of primitives — object elements
        // have flattened sub-keys that the client-side shift handler can't move.
        const hasPrimitiveElements = value.length === 0 || !shouldFlatten(value[0]);
        if (hasPrimitiveElements && oldArr && oldArr.length > 0 && value.length > 0) {
          const shift = detectArrayShiftBoth(oldArr, value);
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
        this._previousArrays.set(key, [...value]);
      }

      const flattened = flattenValue(key, value);
      const newKeys = new Set(flattened.keys());
      // Clear keys that were previously flattened but no longer exist
      const oldKeys = this._flattenedKeys.get(key);
      if (oldKeys) {
        for (const oldPath of oldKeys) {
          if (!newKeys.has(oldPath)) {
            if (isArrayIndexKey(key, oldPath)) continue; // stale array index — client uses .length
            this._clearOne(oldPath);
          }
        }
      }
      this._flattenedKeys.set(key, newKeys);
      for (const [path, leaf] of flattened) {
        this._setLeaf(path, leaf);
      }
      return;
    }
    this._setLeaf(key, value);
  }

  private _buildShiftContext(): ArrayShiftContext {
    return {
      getEntry: (key) => this._entries.get(key),
      setEntryValue: (key, value) => { const e = this._entries.get(key); if (e) e.value = value; },
      setLeaf: (key, value) => this._setLeaf(key, value),
      enqueue: (frame) => { if (this._onValueSet) this._onValueSet(frame); },
      setFlattenedKeys: (key, keys) => this._flattenedKeys.set(key, keys),
      setPreviousArray: (key, arr) => this._previousArrays.set(key, arr),
    };
  }

  private _clearOne(path: string): void {
    if (this._entries.delete(path)) {
      this._cachedKeyFrames = null;
      this._triggerResync();
    }
  }

  private _setLeaf(key: string, value: unknown): void {
    validateKeyPath(key);
    const newType = detectDataType(value);
    serialize(newType, value); // validate

    const existing = this._entries.get(key);

    if (!existing) {
      // New key — use incremental registration if available
      const entry: KeyEntry = {
        keyId: this._nextKeyId++,
        path: key,
        type: newType,
        value,
      };
      this._entries.set(key, entry);
      this._cachedKeyFrames = null;
      if (this._onIncrementalKey) {
        this._onIncrementalKey(
          { frameType: FrameType.ServerKeyRegistration, keyId: entry.keyId, dataType: entry.type, payload: entry.path },
          { frameType: FrameType.ServerSync, keyId: 0, dataType: DataType.Null, payload: null },
          { frameType: FrameType.ServerValue, keyId: entry.keyId, dataType: entry.type, payload: entry.value },
        );
      } else {
        this._triggerResync();
      }
      return;
    }

    if (existing.type !== newType) {
      // Type changed — re-register
      existing.type = newType;
      existing.value = value;
      this._cachedKeyFrames = null;
      this._triggerResync();
      return;
    }

    // Same key, same type — skip if value unchanged
    if (existing.value === value) return;

    existing.value = value;

    if (this._onValueSet) {
      this._onValueSet({
        frameType: FrameType.ServerValue,
        keyId: existing.keyId,
        dataType: existing.type,
        payload: value,
      });
    }
  }

  get(key: string): unknown {
    const entry = this._entries.get(key);
    if (!entry) return undefined;
    return entry.value;
  }

  get keys(): string[] {
    return Array.from(this._entries.keys());
  }

  /**
   * Clear a single key. Triggers re-sync.
   */
  clear(key: string): void;
  /**
   * Clear all keys. Triggers re-sync.
   */
  clear(): void;
  clear(key?: string): void {
    if (key !== undefined) {
      // If this was a flattened key, remove all its children
      const flatKeys = this._flattenedKeys.get(key);
      if (flatKeys) {
        for (const path of flatKeys) this._entries.delete(path);
        this._flattenedKeys.delete(key);
        this._cachedKeyFrames = null;
        this._triggerResync();
      } else if (this._entries.delete(key)) {
        this._cachedKeyFrames = null;
        this._triggerResync();
      }
    } else {
      if (this._entries.size > 0) {
        this._entries.clear();
        this._flattenedKeys.clear();
        this._nextKeyId = 1;
        this._cachedKeyFrames = null;
        this._triggerResync();
      }
    }
  }

  /** @internal — build key registration frames + SYNC for a session */
  _buildKeyFrames(): Frame[] {
    if (this._cachedKeyFrames) return this._cachedKeyFrames;

    const frames: Frame[] = [];
    for (const entry of this._entries.values()) {
      frames.push({
        frameType: FrameType.ServerKeyRegistration,
        keyId: entry.keyId,
        dataType: entry.type,
        payload: entry.path,
      });
    }
    // Always include ServerSync so client transitions from synchronizing to ready
    frames.push({
      frameType: FrameType.ServerSync,
      keyId: 0,
      dataType: DataType.Null,
      payload: null,
    });
    this._cachedKeyFrames = frames;
    return frames;
  }

  /** @internal — build value frames for all keys (full sync) */
  _buildValueFrames(): Frame[] {
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

  private _triggerResync(): void {
    if (this._onKeysChanged) {
      this._onKeysChanged();
    }
  }
}

/**
 * Manages all principals.
 */
export class PrincipalManager {
  private _principals = new Map<string, PrincipalTX>();
  private _sessionCounts = new Map<string, number>(); // principal → active session count
  private _onNewPrincipal: ((ptx: PrincipalTX) => void) | null = null;

  /** @internal */
  _setOnNewPrincipal(fn: (ptx: PrincipalTX) => void): void {
    this._onNewPrincipal = fn;
  }

  principal(name: string): PrincipalTX {
    let ptx = this._principals.get(name);
    if (!ptx) {
      ptx = new PrincipalTX(name);
      this._principals.set(name, ptx);
      if (this._onNewPrincipal) {
        this._onNewPrincipal(ptx);
      }
    }
    return ptx;
  }

  /** List all principals that have at least one active session */
  get principals(): string[] {
    const result: string[] = [];
    for (const [name, count] of this._sessionCounts) {
      if (count > 0) result.push(name);
    }
    return result;
  }

  has(name: string): boolean {
    return this._principals.has(name);
  }

  get(name: string): PrincipalTX | undefined {
    return this._principals.get(name);
  }

  delete(name: string): void {
    this._principals.delete(name);
    this._sessionCounts.delete(name);
  }

  clear(): void {
    this._principals.clear();
    this._sessionCounts.clear();
  }

  /** @internal — track session attach/detach for principal lifecycle */
  _addSession(principal: string): void {
    this._sessionCounts.set(principal, (this._sessionCounts.get(principal) ?? 0) + 1);
  }

  /** @internal — returns true if principal has no more active sessions.
   *  Does NOT delete PrincipalTX data — use delete() for explicit cleanup. */
  _removeSession(principal: string): boolean {
    const count = (this._sessionCounts.get(principal) ?? 1) - 1;
    if (count <= 0) {
      this._sessionCounts.delete(principal);
      return true;
    }
    this._sessionCounts.set(principal, count);
    return false;
  }
}
