import { DataType, FrameType, DanWSError, toError} from "../protocol/types.js";
import type { Frame } from "../protocol/types.js";
import { FlatStateManager } from "./flat-state-manager.js";
import { TopicHandle, TopicPayload } from "./topic-handle.js";

export type SessionState = "pending" | "authorized" | "synchronizing" | "ready" | "disconnected";

export interface TopicInfo {
  name: string;
  params: Record<string, unknown>;
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

  // O(1) index for ClientKeyRequest lookups on TX provider frames
  private _txKeyFrameIndex: Map<number, Frame> | null = null;
  private _txValueFrameIndex: Map<number, Frame> | null = null;

  // Sync tracking
  private _serverSyncSent = false;
  private _clientReadyReceived = false;

  // ──── Session-level flat TX store (topic modes backward compat) ────
  private _nextKeyId = 1;
  private _sessionEnqueue: ((frame: Frame) => void) | null = null;
  private _sessionBound = false;
  private _flatState: FlatStateManager | null = null;

  // ──── Topic handles ────
  private _topicHandles = new Map<string, TopicHandle>();
  private _topicIndex = 0;
  private _topics = new Map<string, TopicInfo>(); // backward compat

  // ──── Size limits ────
  private _maxValueSize: number | undefined;

  // ──── Debug logging ────
  private _debug: boolean | ((msg: string, err?: Error) => void) = false;

  constructor(clientUuid: string) {
    this.id = clientUuid;
  }

  get principal(): string | null { return this._principal; }
  get authorized(): boolean { return this._authorized; }
  get connected(): boolean { return this._connected; }
  get state(): SessionState { return this._state; }

  // ──── Event registration ────

  onReady(cb: () => void): () => void { return this._on(this._onReady, cb); }
  onDisconnect(cb: () => void): () => void { return this._on(this._onDisconnect, cb); }
  onError(cb: (err: DanWSError) => void): () => void { return this._on(this._onError, cb); }

  disconnect(): void {
    this._connected = false;
    this._state = "disconnected";
    this._emit(this._onDisconnect);
  }

  close(): void {
    this._connected = false;
    this._state = "disconnected";
  }

  // ──── Session-level flat data API (backward compat) ────

  set(key: string, value: unknown): void {
    if (!this._sessionBound || !this._flatState) {
      throw new DanWSError("INVALID_MODE", "session.set() is only available in topic modes.");
    }
    this._flatState.set(key, value);
  }

  get(key: string): unknown {
    return this._flatState ? this._flatState.get(key) : undefined;
  }

  get keys(): string[] {
    return this._flatState ? this._flatState.keys : [];
  }

  clearKey(key: string): void;
  clearKey(): void;
  clearKey(key?: string): void {
    if (!this._sessionBound || !this._flatState) return;
    if (key !== undefined) {
      this._flatState.clear(key);
    } else {
      this._flatState.clear();
    }
  }

  // ──── Topic API (backward compat) ────

  get topics(): string[] {
    return Array.from(this._topics.keys());
  }

  topic(name: string): TopicInfo | undefined {
    return this._topics.get(name);
  }

  // ──── Topic Handle API (new) ────

  getTopicHandle(name: string): TopicHandle | undefined {
    return this._topicHandles.get(name);
  }

  get topicHandles(): Map<string, TopicHandle> {
    return this._topicHandles;
  }

  // ──── Internal methods ────

  /** @internal */
  _setDebug(debug: boolean | ((msg: string, err?: Error) => void)): void {
    this._debug = debug;
  }

  /** @internal */
  _setMaxValueSize(size: number): void {
    this._maxValueSize = size;
  }

  /** @internal */
  _setEnqueue(fn: (frame: Frame) => void): void {
    this._enqueueFrame = fn;
  }

  /** @internal */
  _setTxProviders(keyFrames: () => Frame[], valueFrames: () => Frame[]): void {
    this._txKeyFrameProvider = keyFrames;
    this._txValueFrameProvider = valueFrames;
    this._txKeyFrameIndex = null;
    this._txValueFrameIndex = null;
  }

  /** @internal — bind session-level TX (topic modes) */
  _bindSessionTX(enqueue: (frame: Frame) => void): void {
    this._sessionEnqueue = enqueue;
    this._sessionBound = true;
    this._flatState = new FlatStateManager({
      allocateKeyId: () => this._nextKeyId++,
      enqueue,
      onResync: () => this._triggerSessionResync(),
      wirePrefix: "",
      maxValueSize: this._maxValueSize,
    });
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
        if (this._state === "ready") return; // already synced — ignore
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
          this._txKeyFrameIndex = null;
          this._txValueFrameIndex = null;
          this._enqueueFrame({
            frameType: FrameType.ServerReset,
            keyId: 0, dataType: DataType.Null, payload: null,
          });
          for (const f of this._txKeyFrameProvider()) this._enqueueFrame(f);
          this._clientReadyReceived = false;
        }
        break;

      case FrameType.ClientKeyRequest:
        // Client requests info for a specific keyId it doesn't know about
        this._handleKeyRequest(frame.keyId);
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

  /** @internal — backward compat topic management */
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

  get _nextTopicIndex(): number { return this._topicIndex; }

  /** @internal — create a new TopicHandle with scoped payload */
  _createTopicHandle(name: string, params: Record<string, unknown>, wireIndex?: number): TopicHandle {
    const index = wireIndex ?? this._topicIndex++;
    if (index >= this._topicIndex) this._topicIndex = index + 1;
    const payload = new TopicPayload(index, () => this._nextKeyId++, this._maxValueSize);
    if (this._sessionEnqueue) {
      payload._bind(this._sessionEnqueue, () => this._triggerSessionResync());
    }
    const handle = new TopicHandle(name, params, payload, this, (msg, err) => this._log(msg, err));
    this._topicHandles.set(name, handle);
    // Also maintain backward compat topics map
    this._topics.set(name, { name, params });
    return handle;
  }

  /** @internal — remove and dispose a TopicHandle */
  _removeTopicHandle(name: string): void {
    const handle = this._topicHandles.get(name);
    if (handle) {
      handle._dispose();
      this._topicHandles.delete(name);
      this._topics.delete(name);
      this._triggerSessionResync();
    }
  }

  /** @internal — dispose all topic handles (disconnect/close) */
  _disposeAllTopicHandles(): void {
    for (const handle of this._topicHandles.values()) {
      handle._dispose();
    }
    this._topicHandles.clear();
  }

  // ──── Private ────

  private _triggerSessionResync(): void {
    if (!this._sessionEnqueue) return;

    // Invalidate TX key frame index on resync
    this._txKeyFrameIndex = null;
    this._txValueFrameIndex = null;

    // ServerReset
    this._sessionEnqueue({
      frameType: FrameType.ServerReset,
      keyId: 0, dataType: DataType.Null, payload: null,
    });

    // Build flat state frames in a single pass (key + value together)
    let flatValueFrames: Frame[] | undefined;
    if (this._flatState) {
      const { keyFrames, valueFrames } = this._flatState.buildAllFrames();
      for (const f of keyFrames) this._sessionEnqueue(f);
      flatValueFrames = valueFrames;
    }

    // Key registrations: topic payload entries
    for (const handle of this._topicHandles.values()) {
      for (const f of handle.payload._buildKeyFrames()) {
        this._sessionEnqueue(f);
      }
    }

    // ServerSync
    this._sessionEnqueue({
      frameType: FrameType.ServerSync,
      keyId: 0, dataType: DataType.Null, payload: null,
    });

    // Values: flat session entries (from single-pass result)
    if (flatValueFrames) {
      for (const f of flatValueFrames) this._sessionEnqueue(f);
    }

    // Values: topic payload entries
    for (const handle of this._topicHandles.values()) {
      for (const f of handle.payload._buildValueFrames()) {
        this._sessionEnqueue(f);
      }
    }
  }

  private _handleKeyRequest(keyId: number): void {
    if (!this._enqueueFrame) return;

    const syncFrame: Frame = { frameType: FrameType.ServerSync, keyId: 0, dataType: DataType.Null, payload: null };

    // Search in TX providers (broadcast/principal mode) — O(1) via cached index
    if (this._txKeyFrameProvider && this._txValueFrameProvider) {
      if (!this._txKeyFrameIndex) {
        this._txKeyFrameIndex = new Map<number, Frame>();
        for (const f of this._txKeyFrameProvider()) {
          if (f.frameType === FrameType.ServerKeyRegistration) {
            this._txKeyFrameIndex.set(f.keyId, f);
          }
        }
      }
      const keyFrame = this._txKeyFrameIndex.get(keyId);
      if (keyFrame) {
        this._enqueueFrame(keyFrame);
        this._enqueueFrame(syncFrame);
        if (!this._txValueFrameIndex) {
          this._txValueFrameIndex = new Map<number, Frame>();
          for (const f of this._txValueFrameProvider()) {
            this._txValueFrameIndex.set(f.keyId, f);
          }
        }
        const valueFrame = this._txValueFrameIndex.get(keyId);
        if (valueFrame) this._enqueueFrame(valueFrame);
        return;
      }
    }

    // Search in session-level flat state (topic mode) — O(1) via reverse index
    if (this._flatState) {
      const found = this._flatState.getByKeyId(keyId);
      if (found) {
        const wirePath = found.key; // FlatStateManager stores path as key
        this._enqueueFrame({
          frameType: FrameType.ServerKeyRegistration,
          keyId: found.entry.keyId,
          dataType: found.entry.type,
          payload: wirePath,
        });
        this._enqueueFrame(syncFrame);
        if (found.entry.value !== undefined) {
          this._enqueueFrame({
            frameType: FrameType.ServerValue,
            keyId: found.entry.keyId,
            dataType: found.entry.type,
            payload: found.entry.value,
          });
        }
        return;
      }
    }

    // Search in topic payloads (linear scan — TopicPayload API is not modifiable here)
    for (const handle of this._topicHandles.values()) {
      for (const f of handle.payload._buildKeyFrames()) {
        if (f.keyId === keyId) {
          this._enqueueFrame(f);
          this._enqueueFrame(syncFrame);
          for (const vf of handle.payload._buildValueFrames()) {
            if (vf.keyId === keyId) { this._enqueueFrame(vf); break; }
          }
          return;
        }
      }
    }
  }

  private _on<T extends (...args: any[]) => void>(arr: T[], cb: T): () => void {
    arr.push(cb);
    return () => { const i = arr.indexOf(cb); if (i !== -1) arr.splice(i, 1); };
  }

  private _log(msg: string, err?: Error): void {
    if (typeof this._debug === "function") this._debug(msg, err);
    else if (this._debug) console.warn(`[dan-ws session] ${msg}`, err ?? "");
  }

  private _emit<T extends unknown[]>(callbacks: Array<(...args: T) => void>, ...args: T): void {
    for (const cb of callbacks) {
      try { cb(...args); } catch (e) {
        this._log("callback error", toError(e));
      }
    }
  }

  private _emitError(err: DanWSError): void {
    if (this._onError.length === 0) {
      throw err;
    }
    this._emit(this._onError, err);
  }
}

