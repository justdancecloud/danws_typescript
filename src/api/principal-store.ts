import { DataType, FrameType, DanWSError } from "../protocol/types.js";
import type { Frame } from "../protocol/types.js";
import { serialize } from "../protocol/serializer.js";
import { detectDataType } from "../protocol/auto-type.js";
import { validateKeyPath } from "../state/key-registry.js";

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

  /**
   * Set a key-value pair. Auto-detects DataType from the value.
   * If the key is new or its type changes, triggers re-sync to all sessions.
   */
  set(key: string, value: unknown): void {
    validateKeyPath(key);
    const newType = detectDataType(value);
    serialize(newType, value); // validate

    const existing = this._entries.get(key);

    if (!existing) {
      // New key
      const entry: KeyEntry = {
        keyId: this._nextKeyId++,
        path: key,
        type: newType,
        value,
      };
      this._entries.set(key, entry);
      this._triggerResync();
      return;
    }

    if (existing.type !== newType) {
      // Type changed — re-register
      existing.type = newType;
      existing.value = value;
      this._triggerResync();
      return;
    }

    // Same key, same type — just update value and broadcast
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
      if (this._entries.delete(key)) {
        this._triggerResync();
      }
    } else {
      if (this._entries.size > 0) {
        this._entries.clear();
        this._nextKeyId = 1;
        this._triggerResync();
      }
    }
  }

  /** @internal — build key registration frames + SYNC for a session */
  _buildKeyFrames(): Frame[] {
    const frames: Frame[] = [];
    for (const entry of this._entries.values()) {
      frames.push({
        frameType: FrameType.ServerKeyRegistration,
        keyId: entry.keyId,
        dataType: entry.type,
        payload: entry.path,
      });
    }
    if (frames.length > 0) {
      frames.push({
        frameType: FrameType.ServerSync,
        keyId: 0,
        dataType: DataType.Null,
        payload: null,
      });
    }
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

  /** @internal — returns true if principal has no more sessions (should be cleaned up) */
  _removeSession(principal: string): boolean {
    const count = (this._sessionCounts.get(principal) ?? 1) - 1;
    if (count <= 0) {
      this._sessionCounts.delete(principal);
      this._principals.delete(principal);
      return true;
    }
    this._sessionCounts.set(principal, count);
    return false;
  }
}
