import { DataType, FrameType, DanWSError } from "../protocol/types.js";
import type { Frame } from "../protocol/types.js";
import { serialize } from "../protocol/serializer.js";
import { detectDataType } from "../protocol/auto-type.js";
import { validateKeyPath } from "../state/key-registry.js";
import { flattenValue, shouldFlatten } from "./flatten.js";
import { detectArrayShiftBoth, isArrayIndexKey, applyArrayShiftLeft, applyArrayShiftRight, type ArrayShiftContext } from "./array-diff.js";
import { TopicHandle, TopicPayload } from "./topic-handle.js";

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

  // ──── Session-level flat TX store (topic modes backward compat) ────
  private _sessionEntries = new Map<string, KeyEntry>();
  private _nextKeyId = 1; // global keyId counter — shared by flat session keys and all topic payloads
  private _sessionEnqueue: ((frame: Frame) => void) | null = null;
  private _sessionBound = false;
  private _flattenedKeys = new Map<string, Set<string>>();
  private _previousArrays = new Map<string, unknown[]>();

  // ──── Topic handles ────
  private _topicHandles = new Map<string, TopicHandle>();
  private _topicIndex = 0;
  private _topics = new Map<string, TopicInfo>(); // backward compat

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
    if (!this._sessionBound) {
      throw new DanWSError("INVALID_MODE", "session.set() is only available in topic modes.");
    }
    if (shouldFlatten(value)) {
      // Array shift detection for array values
      if (Array.isArray(value)) {
        const oldArr = this._previousArrays.get(key);
        // Only use shift optimization for arrays of primitives
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
      const oldKeys = this._flattenedKeys.get(key);
      let needsResync = false;
      if (oldKeys) {
        for (const oldPath of oldKeys) {
          if (!newKeys.has(oldPath)) {
            if (isArrayIndexKey(key, oldPath)) continue; // stale array index — client uses .length
            this._sessionEntries.delete(oldPath);
            needsResync = true;
          }
        }
      }
      this._flattenedKeys.set(key, newKeys);
      for (const [path, leaf] of flattened) {
        this._setLeaf(path, leaf);
      }
      if (needsResync) this._triggerSessionResync();
      return;
    }
    this._setLeaf(key, value);
  }

  private _buildShiftContext(): ArrayShiftContext {
    return {
      getEntry: (key) => this._sessionEntries.get(key),
      setEntryValue: (key, value) => { const e = this._sessionEntries.get(key); if (e) e.value = value; },
      setLeaf: (key, value) => this._setLeaf(key, value),
      enqueue: (frame) => { if (this._sessionEnqueue) this._sessionEnqueue(frame); },
      setFlattenedKeys: (key, keys) => this._flattenedKeys.set(key, keys),
      setPreviousArray: (key, arr) => this._previousArrays.set(key, arr),
    };
  }

  private _setLeaf(key: string, value: unknown): void {
    validateKeyPath(key);
    const newType = detectDataType(value);
    serialize(newType, value);

    const existing = this._sessionEntries.get(key);

    if (!existing) {
      const entry: KeyEntry = {
        keyId: this._nextKeyId++,
        path: key, type: newType, value,
      };
      this._sessionEntries.set(key, entry);
      if (this._sessionEnqueue) {
        this._sessionEnqueue({ frameType: FrameType.ServerKeyRegistration, keyId: entry.keyId, dataType: entry.type, payload: entry.path });
        this._sessionEnqueue({ frameType: FrameType.ServerSync, keyId: 0, dataType: DataType.Null, payload: null });
        this._sessionEnqueue({ frameType: FrameType.ServerValue, keyId: entry.keyId, dataType: entry.type, payload: entry.value });
      }
      return;
    }

    if (existing.type !== newType) {
      existing.type = newType;
      existing.value = value;
      this._triggerSessionResync();
      return;
    }

    if (existing.value === value) return;

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
      const flatKeys = this._flattenedKeys.get(key);
      if (flatKeys) {
        for (const path of flatKeys) this._sessionEntries.delete(path);
        this._flattenedKeys.delete(key);
        this._triggerSessionResync();
      } else if (this._sessionEntries.delete(key)) {
        this._triggerSessionResync();
      }
    } else {
      if (this._sessionEntries.size > 0) {
        this._sessionEntries.clear();
        this._flattenedKeys.clear();
        this._triggerSessionResync();
      }
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
    const payload = new TopicPayload(index, () => this._nextKeyId++);
    if (this._sessionEnqueue) {
      payload._bind(this._sessionEnqueue, () => this._triggerSessionResync());
    }
    const handle = new TopicHandle(name, params, payload, this);
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

    // ServerReset
    this._sessionEnqueue({
      frameType: FrameType.ServerReset,
      keyId: 0, dataType: DataType.Null, payload: null,
    });

    // Key registrations: flat session entries
    for (const entry of this._sessionEntries.values()) {
      this._sessionEnqueue({
        frameType: FrameType.ServerKeyRegistration,
        keyId: entry.keyId,
        dataType: entry.type,
        payload: entry.path,
      });
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

    // Values: flat session entries
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

    // Values: topic payload entries
    for (const handle of this._topicHandles.values()) {
      for (const f of handle.payload._buildValueFrames()) {
        this._sessionEnqueue(f);
      }
    }
  }

  private _on<T extends (...args: any[]) => void>(arr: T[], cb: T): () => void {
    arr.push(cb);
    return () => { const i = arr.indexOf(cb); if (i !== -1) arr.splice(i, 1); };
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

