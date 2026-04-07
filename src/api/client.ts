import { DataType, FrameType, DanWSError } from "../protocol/types.js";
import type { Frame } from "../protocol/types.js";
import { encode } from "../protocol/codec.js";
import { createStreamParser } from "../protocol/stream-parser.js";
import { detectDataType } from "../protocol/auto-type.js";
import { AuthController } from "../state/auth-controller.js";
import { KeyRegistry } from "../state/key-registry.js";
import { StateStore } from "../state/state-store.js";
import { RecoveryController } from "../state/recovery-controller.js";
import { BulkQueue } from "../connection/bulk-queue.js";
import { HeartbeatManager } from "../connection/heartbeat-manager.js";
import { ReconnectEngine, type ReconnectOptions, DEFAULT_RECONNECT_OPTIONS } from "../connection/reconnect-engine.js";
import { TopicClientHandle } from "./topic-client-handle.js";
import type { TopicClientPayloadView } from "./topic-client-handle.js";
import { createStateProxy } from "./state-proxy.js";

export type ClientState =
  | "disconnected"
  | "connecting"
  | "identifying"
  | "authorizing"
  | "synchronizing"
  | "ready"
  | "reconnecting";

export interface ClientOptions {
  reconnect?: Partial<ReconnectOptions>;
  debug?: boolean | ((msg: string, err?: Error) => void);
}

function generateUUIDv7(): string {
  const now = Date.now();
  const bytes = new Uint8Array(16);
  const ms = BigInt(now);
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  const random = crypto.getRandomValues(new Uint8Array(10));
  bytes.set(random, 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
}

export class DanWebSocketClient {
  readonly id: string;

  private _state: ClientState = "disconnected";
  private _url: string;
  private _ws: WebSocket | null = null;
  private _intentionalDisconnect = false;

  // Server→Client key registry and state
  private _registry = new KeyRegistry();
  private _store = new StateStore();
  private _inboundRecovery = new RecoveryController();

  // Topic state (client→server)
  private _subscriptions = new Map<string, Record<string, unknown>>(); // topicName → params
  private _topicDirty = false;
  private _topicClientHandles = new Map<string, TopicClientHandle>();
  private _topicIndexMap = new Map<string, number>(); // topicName → wire index
  private _indexToTopic = new Map<number, string>(); // wire index → topicName

  // Connection layers
  private _bulkQueue = new BulkQueue();
  private _heartbeat = new HeartbeatManager();
  private _reconnectEngine: ReconnectEngine;
  private _parser = createStreamParser();
  private _debug: boolean | ((msg: string, err?: Error) => void) = false;

  // Callbacks
  private _onConnect: Array<() => void> = [];
  private _onDisconnect: Array<() => void> = [];
  private _onReady: Array<() => void> = [];
  private _onReceive: Array<(key: string, value: unknown) => void> = [];
  private _onReconnecting: Array<(attempt: number, delay: number) => void> = [];
  private _onReconnect: Array<() => void> = [];
  private _onReconnectFailed: Array<() => void> = [];
  private _onUpdate: Array<(payload: Record<string, any>) => void> = [];
  private _onError: Array<(err: DanWSError) => void> = [];

  constructor(url: string, options?: ClientOptions) {
    this._url = url;
    this.id = generateUUIDv7();
    const reconnectOpts = { ...DEFAULT_RECONNECT_OPTIONS, ...options?.reconnect };
    this._debug = options?.debug ?? false;
    this._reconnectEngine = new ReconnectEngine(reconnectOpts);
    this._parser.onFrame((frame) => this._handleFrame(frame));
    this._parser.onHeartbeat(() => this._heartbeat.received());
    this._parser.onError((err) => {
      this._log("Stream parser error", err instanceof Error ? err : new Error(String(err)));
      if (err instanceof DanWSError) this._emitError(err);
    });
    this._setupInternals();
  }

  get state(): ClientState { return this._state; }

  /** Get the current value for a server-registered key. */
  get(key: string): unknown {
    const entry = this._registry.getByPath(key);
    if (!entry) return undefined;
    return this._store.get(entry.keyId);
  }

  /** List all server-registered key paths. */
  get keys(): string[] {
    return this._registry.paths;
  }

  /** Get a Proxy-based state view for nested object access. */
  get data(): Record<string, any> {
    return createStateProxy(
      (key) => this.get(key),
      () => this.keys,
    );
  }

  connect(): void {
    if (this._state !== "disconnected" && this._state !== "reconnecting") return;
    this._intentionalDisconnect = false;
    this._state = "connecting";

    try {
      const WSImpl = this._getWebSocketImpl();
      this._ws = new WSImpl(this._url) as WebSocket;
      this._ws.binaryType = "arraybuffer";
      this._ws.onopen = () => this._handleOpen();
      this._ws.onclose = () => this._handleClose();
      this._ws.onerror = () => {};
      this._ws.onmessage = (ev: any) => this._handleMessage(ev.data);
    } catch (err) {
      this._log("connect failed", err instanceof Error ? err : new Error(String(err)));
      this._handleClose();
    }
  }

  disconnect(): void {
    this._intentionalDisconnect = true;
    this._reconnectEngine.stop();
    this._cleanup();
    this._state = "disconnected";
    this._emit(this._onDisconnect);
  }

  authorize(token: string): void {
    if (!this._ws || this._ws.readyState !== 1) return;
    const frame = AuthController.buildAuthFrame(token);
    this._sendFrame(frame);
    this._state = "authorizing";
  }

  // ──── Topic API ────

  subscribe(topicName: string, params: Record<string, unknown> = {}): void {
    this._subscriptions.set(topicName, params);
    this._sendTopicSync();
  }

  unsubscribe(topicName: string): void {
    if (this._subscriptions.delete(topicName)) {
      this._topicClientHandles.delete(topicName);
      this._sendTopicSync();
    }
  }

  setParams(topicName: string, params: Record<string, unknown>): void {
    if (!this._subscriptions.has(topicName)) return;
    this._subscriptions.set(topicName, params);
    this._sendTopicSync();
  }

  get topics(): string[] {
    return Array.from(this._subscriptions.keys());
  }

  /** Get a topic client handle for scoped data access */
  topic(name: string): TopicClientHandle {
    let handle = this._topicClientHandles.get(name);
    if (!handle) {
      const idx = this._topicIndexMap.get(name) ?? -1;
      handle = new TopicClientHandle(name, idx, this._registry, (id) => this._store.get(id));
      this._topicClientHandles.set(name, handle);
    }
    return handle;
  }

  // ──── Event registration ────

  onConnect(cb: () => void): () => void { return this._on(this._onConnect, cb); }
  onDisconnect(cb: () => void): () => void { return this._on(this._onDisconnect, cb); }
  onReady(cb: () => void): () => void { return this._on(this._onReady, cb); }
  onReceive(cb: (key: string, value: unknown) => void): () => void { return this._on(this._onReceive, cb); }
  onUpdate(cb: (payload: Record<string, any>) => void): () => void { return this._on(this._onUpdate, cb); }
  onReconnecting(cb: (attempt: number, delay: number) => void): () => void { return this._on(this._onReconnecting, cb); }
  onReconnect(cb: () => void): () => void { return this._on(this._onReconnect, cb); }
  onReconnectFailed(cb: () => void): () => void { return this._on(this._onReconnectFailed, cb); }
  onError(cb: (err: DanWSError) => void): () => void { return this._on(this._onError, cb); }

  // ──── Internals ────

  private _setupInternals(): void {
    this._bulkQueue.onFlush((data) => this._sendRaw(data));

    this._heartbeat.onSend((data) => this._sendRaw(data));
    this._heartbeat.onTimeout(() => {
      this._emitError(new DanWSError("HEARTBEAT_TIMEOUT", "No heartbeat received within 15 seconds"));
      this._handleClose();
    });

    this._reconnectEngine.onReconnect((attempt, delay) => {
      this._emit(this._onReconnecting, attempt, delay);
    });
    this._reconnectEngine.onAttempt(() => {
      this.connect();
    });
    this._reconnectEngine.onExhausted(() => {
      this._state = "disconnected";
      this._emitError(new DanWSError("RECONNECT_EXHAUSTED", "All reconnection attempts exhausted"));
      this._emit(this._onReconnectFailed);
    });
  }

  private _handleOpen(): void {
    this._state = "identifying";
    this._heartbeat.start();

    const identifyFrame = AuthController.buildIdentifyFrame(this.id);
    this._sendFrame(identifyFrame);

    this._emit(this._onConnect);

    // Flush any pending topic subscriptions that were queued while disconnected
    if (this._topicDirty && this._subscriptions.size > 0) {
      this._sendTopicSync();
    }
  }

  private _handleClose(): void {
    this._heartbeat.stop();
    this._bulkQueue.clear();

    if (this._ws) {
      this._ws.onopen = null;
      this._ws.onclose = null;
      this._ws.onerror = null;
      this._ws.onmessage = null;
      try { this._ws.close(); } catch {}
      this._ws = null;
    }

    if (this._intentionalDisconnect) return;

    this._emit(this._onDisconnect);

    if (this._reconnectEngine.isActive) {
      // Already reconnecting — schedule next attempt
      this._state = "reconnecting";
      this._reconnectEngine.retry();
    } else {
      // First disconnect — start reconnection cycle
      this._state = "reconnecting";
      this._reconnectEngine.start();
    }
  }

  private _handleMessage(data: ArrayBuffer | ArrayBufferView | string): void {
    if (typeof data === "string") return;
    const bytes = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this._parser.feed(bytes);
  }

  private _handleFrame(frame: Frame): void {
    switch (frame.frameType) {
      case FrameType.AuthOk:
        this._state = "synchronizing";
        break;

      case FrameType.AuthFail:
        this._intentionalDisconnect = true;
        this._emitError(new DanWSError("AUTH_REJECTED", String(frame.payload)));
        this._cleanup();
        this._state = "disconnected";
        this._emit(this._onDisconnect);
        break;

      case FrameType.ServerKeyRegistration: {
        if (this._state === "identifying") {
          this._state = "synchronizing";
        }
        const keyPath = frame.payload as string;
        this._registry.registerOne(frame.keyId, keyPath, frame.dataType);
        break;
      }

      case FrameType.ServerSync: {
        const wasIdentifying = this._state === "identifying";
        if (wasIdentifying) {
          this._state = "synchronizing";
        }
        // Send Client READY during sync (not when already ready — avoids redundant full value re-send)
        if (this._state !== "ready") {
          const readyFrame: Frame = {
            frameType: FrameType.ClientReady,
            keyId: 0, dataType: DataType.Null, payload: null,
          };
          this._bulkQueue.enqueue(readyFrame);
        }

        // If no keys were registered before SYNC, server has no data → go ready immediately
        if (this._registry.size === 0) {
          this._state = "ready";
          this._inboundRecovery.complete();
          this._emit(this._onReady);
          if (this._reconnectEngine.isActive) {
            this._reconnectEngine.stop();
            this._emit(this._onReconnect);
          }
          if (this._subscriptions.size > 0) {
            this._sendTopicSync();
          }
        }
        break;
      }

      case FrameType.ServerValue: {
        if (!this._registry.hasKeyId(frame.keyId)) {
          const resyncFrame = this._inboundRecovery.triggerResync(FrameType.ClientResyncReq);
          if (resyncFrame) this._bulkQueue.enqueue(resyncFrame);
          this._emitError(new DanWSError("UNKNOWN_KEY_ID", `Unknown server key ID: ${frame.keyId}`));
          break;
        }
        this._store.set(frame.keyId, frame.payload);

        const entry = this._registry.getByKeyId(frame.keyId);
        if (entry) {
          // Check if this is a topic-scoped key (t.<idx>.<userKey>)
          const topicMatch = entry.path.match(/^t\.(\d+)\.(.+)$/);
          if (topicMatch) {
            const idx = parseInt(topicMatch[1]);
            const userKey = topicMatch[2];
            const topicName = this._indexToTopic.get(idx);
            if (topicName) {
              const handle = this._topicClientHandles.get(topicName);
              if (handle) handle._notify(userKey, frame.payload);
            }
          } else {
            // Global key (broadcast/principal/flat session)
            for (const cb of this._onReceive) {
              try { cb(entry.path, frame.payload); } catch (e) { this._log("onReceive callback error", e as Error); }
            }
          }
        }

        // Check if this is the initial sync completing
        if (this._state === "synchronizing") {
          this._state = "ready";
          this._inboundRecovery.complete();
          this._emit(this._onReady);
          if (this._reconnectEngine.isActive) {
            this._reconnectEngine.stop();
            this._emit(this._onReconnect);
          }
          // Resend topic subscriptions after (re)connect
          if (this._subscriptions.size > 0) {
            this._sendTopicSync();
          }
        }
        break;
      }

      case FrameType.ArrayShiftLeft: {
        // keyId refers to {array}.length — shift values LEFT by count
        const lengthEntry = this._registry.getByKeyId(frame.keyId);
        if (lengthEntry) {
          const lengthPath = lengthEntry.path;
          const topicMatch = lengthPath.match(/^t\.(\d+)\.(.+)$/);
          let prefix: string;
          let isTopic = false;
          let topicIdx = -1;
          let userPrefix = "";

          if (topicMatch) {
            isTopic = true;
            topicIdx = parseInt(topicMatch[1]);
            const userKey = topicMatch[2];
            userPrefix = userKey.slice(0, userKey.length - ".length".length);
            prefix = lengthPath.slice(0, lengthPath.length - ".length".length);
          } else {
            prefix = lengthPath.slice(0, lengthPath.length - ".length".length);
          }

          const shiftCount = frame.payload as number;
          const currentLenObj = this._store.get(frame.keyId);
          const currentLength = typeof currentLenObj === "number" ? currentLenObj : 0;

          // Shift values left: prefix.0 <- prefix.{shift}, prefix.1 <- prefix.{shift+1}, etc.
          for (let i = 0; i < currentLength - shiftCount; i++) {
            const src = this._registry.getByPath(`${prefix}.${i + shiftCount}`);
            const dst = this._registry.getByPath(`${prefix}.${i}`);
            if (src && dst) {
              this._store.set(dst.keyId, this._store.get(src.keyId));
            }
          }

          // Update length
          const newLength = currentLength - shiftCount;
          this._store.set(frame.keyId, newLength);

          // Fire callbacks
          if (isTopic) {
            const topicName = this._indexToTopic.get(topicIdx);
            if (topicName) {
              const handle = this._topicClientHandles.get(topicName);
              if (handle) handle._notify(userPrefix + ".length", newLength);
            }
          } else {
            for (const cb of this._onReceive) {
              try { cb(prefix + ".length", newLength); } catch (e) { this._log("onReceive callback error", e as Error); }
            }
          }
        }
        break;
      }

      case FrameType.ArrayShiftRight: {
        // keyId refers to {array}.length — shift values RIGHT by count
        const lengthEntry = this._registry.getByKeyId(frame.keyId);
        if (lengthEntry) {
          const lengthPath = lengthEntry.path;
          const topicMatch = lengthPath.match(/^t\.(\d+)\.(.+)$/);
          let prefix: string;
          let isTopic = false;
          let topicIdx = -1;
          let userPrefix = "";

          if (topicMatch) {
            isTopic = true;
            topicIdx = parseInt(topicMatch[1]);
            const userKey = topicMatch[2];
            userPrefix = userKey.slice(0, userKey.length - ".length".length);
            prefix = lengthPath.slice(0, lengthPath.length - ".length".length);
          } else {
            prefix = lengthPath.slice(0, lengthPath.length - ".length".length);
          }

          const shiftCount = frame.payload as number;
          const currentLenObj = this._store.get(frame.keyId);
          const currentLength = typeof currentLenObj === "number" ? currentLenObj : 0;

          // Shift values right: iterate from high to low to avoid overwriting
          for (let i = currentLength - 1; i >= 0; i--) {
            const src = this._registry.getByPath(`${prefix}.${i}`);
            const dst = this._registry.getByPath(`${prefix}.${i + shiftCount}`);
            if (src && dst) {
              this._store.set(dst.keyId, this._store.get(src.keyId));
            }
          }

          // Do NOT update length here — server sends length update separately if needed

          // Fire callbacks
          if (isTopic) {
            const topicName = this._indexToTopic.get(topicIdx);
            if (topicName) {
              const handle = this._topicClientHandles.get(topicName);
              if (handle) handle._notify(userPrefix + ".length", currentLength);
            }
          } else {
            for (const cb of this._onReceive) {
              try { cb(prefix + ".length", currentLength); } catch (e) { this._log("onReceive callback error", e as Error); }
            }
          }
        }
        break;
      }

      case FrameType.ServerFlushEnd: {
        // Batch boundary — fire onUpdate once for the entire flush
        if (this._onUpdate.length > 0) {
          const view = createStateProxy((k) => this.get(k), () => this.keys);
          for (const cb of this._onUpdate) {
            try { cb(view); } catch (e) { this._log("onUpdate callback error", e as Error); }
          }
        }
        // Flush topic-level onUpdate callbacks
        for (const handle of this._topicClientHandles.values()) {
          handle._flushUpdate();
        }
        break;
      }

      case FrameType.ServerReady:
        // Server acknowledged our topic sync — no action needed
        break;

      case FrameType.ServerReset:
        this._registry.clear();
        this._store.clear();
        this._state = "synchronizing";
        break;

      case FrameType.Error:
        this._emitError(new DanWSError("REMOTE_ERROR", String(frame.payload)));
        break;
    }
  }

  private _sendTopicSync(): void {
    if (!this._ws || this._ws.readyState !== 1) {
      this._topicDirty = true;
      return;
    }

    // Build flat key-value list from subscriptions using index-based keys:
    // "topic.<idx>.name" = topicName (String)
    // "topic.<idx>.param.<paramKey>" = value
    const entries: Array<{ path: string; value: unknown }> = [];
    this._topicIndexMap.clear();
    this._indexToTopic.clear();
    let idx = 0;
    for (const [topicName, params] of this._subscriptions) {
      this._topicIndexMap.set(topicName, idx);
      this._indexToTopic.set(idx, topicName);
      // Update or create client handle with correct index
      let handle = this._topicClientHandles.get(topicName);
      if (!handle) {
        handle = new TopicClientHandle(topicName, idx, this._registry, (id) => this._store.get(id));
        this._topicClientHandles.set(topicName, handle);
      } else {
        handle._setIndex(idx);
      }
      entries.push({ path: `topic.${idx}.name`, value: topicName });
      for (const [paramKey, paramValue] of Object.entries(params)) {
        entries.push({ path: `topic.${idx}.param.${paramKey}`, value: paramValue });
      }
      idx++;
    }

    // Send ClientReset
    this._sendFrame({
      frameType: FrameType.ClientReset,
      keyId: 0, dataType: DataType.Null, payload: null,
    });

    // Send ClientKeyRegistration for each entry
    let keyId = 1;
    const keyIds: Array<{ id: number; value: unknown; dataType: DataType }> = [];
    for (const entry of entries) {
      const dt = detectDataType(entry.value);
      this._sendFrame({
        frameType: FrameType.ClientKeyRegistration,
        keyId,
        dataType: dt,
        payload: entry.path,
      });
      keyIds.push({ id: keyId, value: entry.value, dataType: dt });
      keyId++;
    }

    // Send ClientValue for each entry (BEFORE sync!)
    for (const entry of keyIds) {
      this._sendFrame({
        frameType: FrameType.ClientValue,
        keyId: entry.id,
        dataType: entry.dataType,
        payload: entry.value,
      });
    }

    // Send ClientSync (signals: all keys + values sent)
    this._sendFrame({
      frameType: FrameType.ClientSync,
      keyId: 0, dataType: DataType.Null, payload: null,
    });

    this._topicDirty = false;
  }

  private _sendFrame(frame: Frame): void {
    this._sendRaw(encode(frame));
  }

  private _sendRaw(data: Uint8Array): void {
    if (this._ws && this._ws.readyState === 1) {
      this._ws.send(data as any);
    }
  }

  private _cleanup(): void {
    this._heartbeat.stop();
    this._bulkQueue.clear();
    if (this._ws) {
      this._ws.onopen = null;
      this._ws.onclose = null;
      this._ws.onerror = null;
      this._ws.onmessage = null;
      try { this._ws.close(); } catch {}
      this._ws = null;
    }
  }

  private _getWebSocketImpl(): any {
    if (typeof globalThis.WebSocket !== "undefined") return globalThis.WebSocket;
    // Node.js — lazy import to avoid browser bundlers pulling in ws
    try {
      const g = globalThis as Record<string, any>;
      const _require = g["require"] as ((id: string) => any) | undefined;
      if (_require) return _require("ws");
    } catch {}
    throw new DanWSError("NO_WEBSOCKET", "No WebSocket implementation found. Install 'ws' for Node.js.");
  }

  private _log(msg: string, err?: Error): void {
    if (typeof this._debug === "function") this._debug(msg, err);
    else if (this._debug) console.warn(`[dan-ws client] ${msg}`, err ?? "");
  }

  private _on<T extends (...args: any[]) => void>(arr: T[], cb: T): () => void {
    arr.push(cb);
    return () => { const i = arr.indexOf(cb); if (i !== -1) arr.splice(i, 1); };
  }

  private _emit<T extends unknown[]>(callbacks: Array<(...args: T) => void>, ...args: T): void {
    for (const cb of callbacks) {
      try { cb(...args); } catch (e) { this._log("Callback error", e as Error); }
    }
  }

  private _emitError(err: DanWSError): void {
    this._emit(this._onError, err);
  }
}
