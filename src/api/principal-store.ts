import { DataType, FrameType, DanWSError } from "../protocol/types.js";
import type { Frame } from "../protocol/types.js";
import { KeyRegistry, validateKeyPath, type KeyDefinition } from "../state/key-registry.js";
import { StateStore } from "../state/state-store.js";
import { serialize } from "../protocol/serializer.js";

/**
 * Shared TX state for one principal.
 * All sessions of the same principal share this state.
 */
export class PrincipalTX {
  readonly name: string;
  private _registry = new KeyRegistry();
  private _store = new StateStore();
  private _onValueSet: ((frame: Frame) => void) | null = null;

  constructor(name: string) {
    this.name = name;
  }

  /** @internal — callback when set() is called (for broadcasting to sessions) */
  _onValue(fn: (frame: Frame) => void): void {
    this._onValueSet = fn;
  }

  updateKeys(keys: KeyDefinition[]): void {
    const paths = new Set<string>();
    for (const k of keys) {
      validateKeyPath(k.path);
      if (paths.has(k.path)) {
        throw new DanWSError("DUPLICATE_KEY_PATH", `Duplicate key path: "${k.path}"`);
      }
      paths.add(k.path);
    }
    this._registry.register(keys);
  }

  set(key: string, value: unknown): void {
    const entry = this._registry.getByPath(key);
    if (!entry) {
      throw new DanWSError("KEY_NOT_REGISTERED", `Key not registered: "${key}". Call updateKeys() first.`);
    }

    serialize(entry.type, value); // validate
    this._store.set(entry.keyId, value);

    if (this._onValueSet) {
      this._onValueSet({
        frameType: FrameType.ServerValue,
        keyId: entry.keyId,
        dataType: entry.type,
        payload: value,
      });
    }
  }

  get(key: string): unknown {
    const entry = this._registry.getByPath(key);
    if (!entry) {
      throw new DanWSError("KEY_NOT_REGISTERED", `Key not registered: "${key}"`);
    }
    return this._store.get(entry.keyId);
  }

  get keys(): string[] {
    return this._registry.paths;
  }

  /** @internal — build key registration frames + SYNC for a new session */
  _buildKeyFrames(): Frame[] {
    const frames: Frame[] = [];
    for (const entry of this._registry.entries()) {
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

  /** @internal — build value frames for all registered keys (full sync) */
  _buildValueFrames(): Frame[] {
    const frames: Frame[] = [];
    for (const entry of this._registry.entries()) {
      if (this._store.has(entry.keyId)) {
        frames.push({
          frameType: FrameType.ServerValue,
          keyId: entry.keyId,
          dataType: entry.type,
          payload: this._store.get(entry.keyId),
        });
      }
    }
    return frames;
  }

  get _registryRef(): KeyRegistry {
    return this._registry;
  }
}

/**
 * Manages all principals.
 * server.tx.principal("alice") returns the shared TX for "alice".
 */
export class PrincipalManager {
  private _principals = new Map<string, PrincipalTX>();
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

  has(name: string): boolean {
    return this._principals.has(name);
  }

  get(name: string): PrincipalTX | undefined {
    return this._principals.get(name);
  }

  delete(name: string): void {
    this._principals.delete(name);
  }

  clear(): void {
    this._principals.clear();
  }
}
