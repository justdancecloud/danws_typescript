import { DataType, FrameType, DanWSError } from "../protocol/types.js";
import type { Frame } from "../protocol/types.js";
import { serialize } from "../protocol/serializer.js";
import { detectDataType } from "../protocol/auto-type.js";
import { validateKeyPath } from "../state/key-registry.js";

export type SessionState = "pending" | "authorized" | "synchronizing" | "ready" | "disconnected";

export interface TopicInfo {
  name: string;
  params: Record<string, unknown>;
}

interface KeyEntry {
  keyId: number;
  path: string;
  type: DataType;
  value: unknown;
}

export class DanWebSocketSession {
  readonly id: string;
  private _principal: string | null = null;
  private _authorized = false;
  private _connected = true;
  private _state: SessionState = "pending";

  private _enqueueFrame: ((frame: Frame) => void) | null = null;

  // Callbacks
  private _onReady: Array<() => void> = [];
  private _onDisconnect: Array<() => void> = [];
  private _onError: Array<(err: DanWSError) => void> = [];

  // Provider for TX frames (from principal shared state — broadcast/principal modes)
  private _txKeyFrameProvider: (() => Frame[]) | null = null;
  private _txValueFrameProvider: (() => Frame[]) | null = null;

  // Sync tracking
  private _serverSyncSent = false;
  private _clientReadyReceived = false;

  // ──── Session-level TX store (topic modes) ────
  private _sessionEntries = new Map<string, KeyEntry>();
  private _sessionNextKeyId = 1;
  private _sessionEnqueue: ((frame: Frame) => void) | null = null;
  private _sessionBound = false;

  // ──── Topic state ────
  private _topics = new Map<string, TopicInfo>();

  constructor(clientUuid: string) {
    this.id = clientUuid;
  }

  get principal(): string | null { return this._principal; }
  get authorized(): boolean { return this._authorized; }
  get connected(): boolean { return this._connected; }
  get state(): SessionState { return this._state; }

  // ──── Event registration ────

  onReady(cb: () => void): void { this._onReady.push(cb); }
  onDisconnect(cb: () => void): void { this._onDisconnect.push(cb); }
  onError(cb: (err: DanWSError) => void): void { this._onError.push(cb); }

  disconnect(): void {
    this._connected = false;
    this._state = "disconnected";
    this._emit(this._onDisconnect);
  }

  close(): void {
    this._connected = false;
    this._state = "disconnected";
  }

  // ──── Session-level data API (topic modes) ────

  set(key: string, value: unknown): void {
    if (!this._sessionBound) {
      throw new DanWSError("INVALID_MODE", "session.set() is only available in topic modes.");
    }
    validateKeyPath(key);
    const newType = detectDataType(value);
    serialize(newType, value);

    const existing = this._sessionEntries.get(key);

    if (!existing) {
      const entry: KeyEntry = {
        keyId: this._sessionNextKeyId++,
        path: key,
        type: newType,
        value,
      };
      this._sessionEntries.set(key, entry);
      this._triggerSessionResync();
      return;
    }

    if (existing.type !== newType) {
      existing.type = newType;
      existing.value = value;
      this._triggerSessionResync();
      return;
    }

    existing.value = value;
    if (this._sessionEnqueue) {
      this._sessionEnqueue({
        frameType: FrameType.ServerValue,
        keyId: existing.keyId,
        dataType: existing.type,
        payload: value,
      });
    }
  }

  get(key: string): unknown {
    const entry = this._sessionEntries.get(key);
    return entry ? entry.value : undefined;
  }

  get keys(): string[] {
    return Array.from(this._sessionEntries.keys());
  }

  clearKey(key: string): void;
  clearKey(): void;
  clearKey(key?: string): void {
    if (!this._sessionBound) return;
    if (key !== undefined) {
      if (this._sessionEntries.delete(key)) this._triggerSessionResync();
    } else {
      if (this._sessionEntries.size > 0) {
        this._sessionEntries.clear();
        this._sessionNextKeyId = 1;
        this._triggerSessionResync();
      }
    }
  }

  // ──── Topic API ────

  get topics(): string[] {
    return Array.from(this._topics.keys());
  }

  topic(name: string): TopicInfo | undefined {
    return this._topics.get(name);
  }

  // ──── Internal methods ────

  /** @internal */
  _setEnqueue(fn: (frame: Frame) => void): void {
    this._enqueueFrame = fn;
  }

  /** @internal */
  _setTxProviders(keyFrames: () => Frame[], valueFrames: () => Frame[]): void {
    this._txKeyFrameProvider = keyFrames;
    this._txValueFrameProvider = valueFrames;
  }

  /** @internal — bind session-level TX (topic modes) */
  _bindSessionTX(enqueue: (frame: Frame) => void): void {
    this._sessionEnqueue = enqueue;
    this._sessionBound = true;
  }

  /** @internal */
  _authorize(principal: string): void {
    this._principal = principal;
    this._authorized = true;
    this._state = "authorized";
  }

  /** @internal — start server→client synchronization */
  _startSync(): void {
    this._state = "synchronizing";
    this._serverSyncSent = false;
    this._clientReadyReceived = false;

    if (this._txKeyFrameProvider && this._enqueueFrame) {
      const frames = this._txKeyFrameProvider();
      if (frames.length > 0) {
        for (const f of frames) this._enqueueFrame(f);
        this._serverSyncSent = true;
      } else {
        this._enqueueFrame({
          frameType: FrameType.ServerSync,
          keyId: 0, dataType: DataType.Null, payload: null,
        });
        this._serverSyncSent = true;
      }
    } else {
      this._state = "ready";
      this._emit(this._onReady);
    }
  }

  /** @internal — handle incoming frame from client */
  _handleFrame(frame: Frame): void {
    switch (frame.frameType) {
      case FrameType.ClientReady:
        this._clientReadyReceived = true;
        if (this._txValueFrameProvider && this._enqueueFrame) {
          for (const vf of this._txValueFrameProvider()) this._enqueueFrame(vf);
        }
        if (this._serverSyncSent) {
          this._state = "ready";
          this._emit(this._onReady);
        }
        break;

      case FrameType.ClientResyncReq:
        if (this._txKeyFrameProvider && this._enqueueFrame) {
          this._enqueueFrame({
            frameType: FrameType.ServerReset,
            keyId: 0, dataType: DataType.Null, payload: null,
          });
          for (const f of this._txKeyFrameProvider()) this._enqueueFrame(f);
          this._clientReadyReceived = false;
        }
        break;

      case FrameType.Error:
        this._emitError(new DanWSError("REMOTE_ERROR", String(frame.payload)));
        break;
    }
  }

  /** @internal */
  _handleDisconnect(): void {
    this._connected = false;
    this._state = "disconnected";
    this._emit(this._onDisconnect);
  }

  /** @internal */
  _handleReconnect(): void {
    this._connected = true;
    this._state = "authorized";
  }

  /** @internal — topic management */
  _addTopic(name: string, params: Record<string, unknown>): void {
    this._topics.set(name, { name, params });
  }

  /** @internal */
  _removeTopic(name: string): boolean {
    return this._topics.delete(name);
  }

  /** @internal */
  _updateTopicParams(name: string, params: Record<string, unknown>): void {
    const t = this._topics.get(name);
    if (t) t.params = params;
  }

  // ──── Private ────

  private _triggerSessionResync(): void {
    if (!this._sessionEnqueue) return;

    // Send ServerReset + re-register all keys + ServerSync + values
    this._sessionEnqueue({
      frameType: FrameType.ServerReset,
      keyId: 0, dataType: DataType.Null, payload: null,
    });

    for (const entry of this._sessionEntries.values()) {
      this._sessionEnqueue({
        frameType: FrameType.ServerKeyRegistration,
        keyId: entry.keyId,
        dataType: entry.type,
        payload: entry.path,
      });
    }

    this._sessionEnqueue({
      frameType: FrameType.ServerSync,
      keyId: 0, dataType: DataType.Null, payload: null,
    });

    for (const entry of this._sessionEntries.values()) {
      if (entry.value !== undefined) {
        this._sessionEnqueue({
          frameType: FrameType.ServerValue,
          keyId: entry.keyId,
          dataType: entry.type,
          payload: entry.value,
        });
      }
    }
  }

  private _emit<T extends unknown[]>(callbacks: Array<(...args: T) => void>, ...args: T): void {
    for (const cb of callbacks) {
      try { cb(...args); } catch {}
    }
  }

  private _emitError(err: DanWSError): void {
    this._emit(this._onError, err);
  }
}
