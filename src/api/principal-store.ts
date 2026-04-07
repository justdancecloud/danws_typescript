import { DataType, FrameType } from "../protocol/types.js";
import type { Frame } from "../protocol/types.js";
import { FlatStateManager } from "./flat-state-manager.js";

/**
 * Shared TX state for one principal.
 * All sessions of the same principal share this state.
 */
export class PrincipalTX {
  readonly name: string;
  private _nextKeyId = 1;
  private _onValueSet: ((frame: Frame) => void) | null = null;
  private _onKeysChanged: (() => void) | null = null;
  private _onIncrementalKey: ((keyFrame: Frame, syncFrame: Frame, valueFrame: Frame) => void) | null = null;
  private _cachedKeyFrames: Frame[] | null = null;
  private _flatState: FlatStateManager;

  constructor(name: string) {
    this.name = name;
    this._flatState = new FlatStateManager({
      allocateKeyId: () => this._nextKeyId++,
      enqueue: (frame) => { if (this._onValueSet) this._onValueSet(frame); },
      onResync: () => this._triggerResync(),
      wirePrefix: "",
      onIncrementalKey: (kf, sf, vf) => {
        if (this._onIncrementalKey) {
          this._onIncrementalKey(kf, sf, vf);
        } else {
          this._triggerResync();
        }
      },
      onKeyStructureChange: () => { this._cachedKeyFrames = null; },
    });
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

  set(key: string, value: unknown): void {
    this._flatState.set(key, value);
  }

  get(key: string): unknown {
    return this._flatState.get(key);
  }

  get keys(): string[] {
    return this._flatState.keys;
  }

  clear(key: string): void;
  clear(): void;
  clear(key?: string): void {
    if (key !== undefined) {
      this._flatState.clear(key);
    } else {
      this._flatState.clear();
      this._nextKeyId = 1;
    }
  }

  /** @internal — build key registration frames + SYNC for a session */
  _buildKeyFrames(): Frame[] {
    if (this._cachedKeyFrames) return this._cachedKeyFrames;

    const frames = this._flatState.buildKeyFrames();
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
    return this._flatState.buildValueFrames();
  }

  private _triggerResync(): void {
    this._cachedKeyFrames = null;
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
  private _sessionCounts = new Map<string, number>();
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

  /** @internal */
  _addSession(principal: string): void {
    this._sessionCounts.set(principal, (this._sessionCounts.get(principal) ?? 0) + 1);
  }

  /** @internal */
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
