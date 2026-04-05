import { DataType, DanWSError } from "../protocol/types.js";
import type { Frame } from "../protocol/types.js";
import { KeyRegistry, validateKeyPath, type KeyDefinition } from "../state/key-registry.js";
import { StateStore } from "../state/state-store.js";
import { HandshakeController, type HandshakeRole } from "../state/handshake-controller.js";
import { serialize } from "../protocol/serializer.js";

export class TXChannel {
  private _handshake: HandshakeController;
  private _pendingKeys: KeyDefinition[] | null = null;
  private _enqueueFrame: ((frame: Frame) => void) | null = null;
  private _broadcastMode = false;

  constructor(handshake: HandshakeController) {
    this._handshake = handshake;
  }

  /** @internal — enable broadcast mode (always enqueue) */
  _setBroadcastMode(): void {
    this._broadcastMode = true;
  }

  /** @internal */
  _setEnqueue(fn: (frame: Frame) => void): void {
    this._enqueueFrame = fn;
  }

  updateKeys(keys: KeyDefinition[]): void {
    // Validate all paths upfront
    const paths = new Set<string>();
    for (const k of keys) {
      validateKeyPath(k.path);
      if (paths.has(k.path)) {
        throw new DanWSError("DUPLICATE_KEY_PATH", `Duplicate key path: "${k.path}"`);
      }
      paths.add(k.path);
    }

    this._pendingKeys = keys;

    if (this._handshake.phase === "ready" || this._handshake.phase === "synced") {
      // Already connected — send reset + re-register
      const frames = this._handshake.buildResetAndRegistrationFrames(keys);
      if (this._enqueueFrame) {
        for (const f of frames) this._enqueueFrame(f);
      }
    } else {
      // Not connected yet — register locally so set()/get() work
      this._handshake.registry.register(keys);
    }
  }

  /** @internal — get pending keys for initial handshake */
  _getPendingKeys(): KeyDefinition[] | null {
    return this._pendingKeys;
  }

  /** @internal — perform initial registration and return frames */
  _buildInitialRegistration(): Frame[] {
    if (!this._pendingKeys) return [];
    return this._handshake.buildRegistrationFrames(this._pendingKeys);
  }

  set(key: string, value: unknown): void {
    const entry = this._handshake.registry.getByPath(key);
    if (!entry) {
      throw new DanWSError("KEY_NOT_REGISTERED", `Key not registered: "${key}". Call updateKeys() first.`);
    }

    // Validate type
    serialize(entry.type, value);

    this._handshake.store.set(entry.keyId, value);

    if ((this._broadcastMode || this._handshake.canSendValues()) && this._enqueueFrame) {
      const frame = this._handshake.buildValueFrame(entry.keyId, value);
      if (frame) this._enqueueFrame(frame);
    }
  }

  get(key: string): unknown {
    const entry = this._handshake.registry.getByPath(key);
    if (!entry) {
      throw new DanWSError("KEY_NOT_REGISTERED", `Key not registered: "${key}"`);
    }
    return this._handshake.store.get(entry.keyId);
  }

  get keys(): string[] {
    return this._handshake.registry.paths;
  }
}

export class RXChannel {
  private _registry = new KeyRegistry();
  private _store = new StateStore();
  private _receiveCallbacks: Array<(key: string, value: unknown) => void> = [];

  get keys(): string[] {
    return this._registry.paths;
  }

  get(key: string): unknown {
    const entry = this._registry.getByPath(key);
    if (!entry) return undefined;
    return this._store.get(entry.keyId);
  }

  onReceive(callback: (key: string, value: unknown) => void): void {
    this._receiveCallbacks.push(callback);
  }

  /** @internal — called when remote registers a key */
  _registerKey(keyId: number, dataType: DataType, keyPath: string): void {
    this._registry.registerOne(keyId, keyPath, dataType);
  }

  /** @internal — called when a value is received */
  _receiveValue(keyId: number, value: unknown): void {
    const entry = this._registry.getByKeyId(keyId);
    if (!entry) return;

    this._store.set(keyId, value);

    for (const cb of this._receiveCallbacks) {
      cb(entry.path, value);
    }
  }

  /** @internal — check if keyId is registered */
  _hasKeyId(keyId: number): boolean {
    return this._registry.hasKeyId(keyId);
  }

  /** @internal — clear for reset */
  _reset(): void {
    this._registry.clear();
    this._store.clear();
  }

  /** @internal */
  get _registryRef(): KeyRegistry {
    return this._registry;
  }
}
