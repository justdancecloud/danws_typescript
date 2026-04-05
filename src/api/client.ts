import { WebSocket as NodeWebSocket } from "ws";
import { DataType, FrameType, DanWSError } from "../protocol/types.js";
import type { Frame } from "../protocol/types.js";
import { encode } from "../protocol/codec.js";
import { createStreamParser } from "../protocol/stream-parser.js";
import { AuthController } from "../state/auth-controller.js";
import { KeyRegistry } from "../state/key-registry.js";
import { StateStore } from "../state/state-store.js";
import { RecoveryController } from "../state/recovery-controller.js";
import { BulkQueue } from "../connection/bulk-queue.js";
import { HeartbeatManager } from "../connection/heartbeat-manager.js";
import { ReconnectEngine, type ReconnectOptions, DEFAULT_RECONNECT_OPTIONS } from "../connection/reconnect-engine.js";

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

  // Connection layers
  private _bulkQueue = new BulkQueue();
  private _heartbeat = new HeartbeatManager();
  private _reconnectEngine: ReconnectEngine;

  // Callbacks
  private _onConnect: Array<() => void> = [];
  private _onDisconnect: Array<() => void> = [];
  private _onReady: Array<() => void> = [];
  private _onReceive: Array<(key: string, value: unknown) => void> = [];
  private _onReconnecting: Array<(attempt: number, delay: number) => void> = [];
  private _onReconnect: Array<() => void> = [];
  private _onReconnectFailed: Array<() => void> = [];
  private _onError: Array<(err: DanWSError) => void> = [];

  constructor(url: string, options?: ClientOptions) {
    this._url = url;
    this.id = generateUUIDv7();
    const reconnectOpts = { ...DEFAULT_RECONNECT_OPTIONS, ...options?.reconnect };
    this._reconnectEngine = new ReconnectEngine(reconnectOpts);
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

  connect(): void {
    if (this._state !== "disconnected" && this._state !== "reconnecting") return;
    this._intentionalDisconnect = false;
    this._state = "connecting";

    try {
      const WSImpl = (typeof globalThis.WebSocket !== "undefined" ? globalThis.WebSocket : NodeWebSocket) as any;
      this._ws = new WSImpl(this._url) as WebSocket;
      this._ws.binaryType = "arraybuffer";
      this._ws.onopen = () => this._handleOpen();
      this._ws.onclose = () => this._handleClose();
      this._ws.onerror = () => {};
      this._ws.onmessage = (ev: any) => this._handleMessage(ev.data);
    } catch {
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

  // ──── Event registration ────

  onConnect(cb: () => void): void { this._onConnect.push(cb); }
  onDisconnect(cb: () => void): void { this._onDisconnect.push(cb); }
  onReady(cb: () => void): void { this._onReady.push(cb); }
  onReceive(cb: (key: string, value: unknown) => void): void { this._onReceive.push(cb); }
  onReconnecting(cb: (attempt: number, delay: number) => void): void { this._onReconnecting.push(cb); }
  onReconnect(cb: () => void): void { this._onReconnect.push(cb); }
  onReconnectFailed(cb: () => void): void { this._onReconnectFailed.push(cb); }
  onError(cb: (err: DanWSError) => void): void { this._onError.push(cb); }

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

    this._state = "reconnecting";
    this._emit(this._onDisconnect);
    this._reconnectEngine.start();
  }

  private _handleMessage(data: ArrayBuffer | Buffer | string): void {
    if (typeof data === "string") return;
    const bytes = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

    const parser = createStreamParser();
    parser.onFrame((frame) => this._handleFrame(frame));
    parser.onHeartbeat(() => this._heartbeat.received());
    parser.onError((err) => {
      if (err instanceof DanWSError) this._emitError(err);
    });
    parser.feed(bytes);
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
        if (this._state === "identifying") {
          this._state = "synchronizing";
        }
        // Send Client READY
        const readyFrame: Frame = {
          frameType: FrameType.ClientReady,
          keyId: 0, dataType: DataType.Null, payload: null,
        };
        this._bulkQueue.enqueue(readyFrame);
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
          for (const cb of this._onReceive) {
            try { cb(entry.path, frame.payload); } catch {}
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
        }
        break;
      }

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

  private _emit<T extends unknown[]>(callbacks: Array<(...args: T) => void>, ...args: T): void {
    for (const cb of callbacks) {
      try { cb(...args); } catch {}
    }
  }

  private _emitError(err: DanWSError): void {
    this._emit(this._onError, err);
  }
}
