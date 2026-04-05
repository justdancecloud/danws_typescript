import { DataType, FrameType, DanWSError } from "../protocol/types.js";
import type { Frame } from "../protocol/types.js";
import { HandshakeController } from "../state/handshake-controller.js";
import { TXChannel, RXChannel } from "./channels.js";

export type SessionState = "pending" | "authorized" | "synchronizing" | "ready" | "recovering" | "disconnected";

export class DanWebSocketSession {
  readonly id: string;
  private _username: string | null = null;
  private _authorized = false;
  private _connected = true;
  private _state: SessionState = "pending";

  private _txHandshake = new HandshakeController("server-to-client");
  private _rxHandshake = new HandshakeController("client-to-server");

  readonly tx: TXChannel;
  readonly rx: RXChannel;

  // Internal frame sender
  private _enqueueFrame: ((frame: Frame) => void) | null = null;

  // Callbacks
  private _onReady: Array<() => void> = [];
  private _onRecovery: Array<(direction: "inbound" | "outbound") => void> = [];
  private _onDisconnect: Array<() => void> = [];
  private _onError: Array<(err: DanWSError) => void> = [];

  private _broadcastValueProvider: (() => Frame[]) | null = null;

  // Sync tracking
  private _serverSyncSent = false;
  private _clientReadyReceived = false;
  private _clientSyncReceived = false;
  private _serverReadySent = false;

  constructor(clientUuid: string) {
    this.id = clientUuid;
    this.tx = new TXChannel(this._txHandshake);
    this.rx = new RXChannel();
  }

  get username(): string | null { return this._username; }
  get authorized(): boolean { return this._authorized; }
  get connected(): boolean { return this._connected; }
  get state(): SessionState { return this._state; }

  // ──── Event registration ────

  onReady(cb: () => void): void { this._onReady.push(cb); }
  onRecovery(cb: (direction: "inbound" | "outbound") => void): void { this._onRecovery.push(cb); }
  onDisconnect(cb: () => void): void { this._onDisconnect.push(cb); }
  onError(cb: (err: DanWSError) => void): void { this._onError.push(cb); }

  disconnect(): void {
    this._connected = false;
    this._state = "disconnected";
    this._emit(this._onDisconnect);
  }

  close(): void {
    // Implemented by server — destroys session
    this._connected = false;
    this._state = "disconnected";
  }

  // ──── Internal methods ────

  /** @internal */
  _setBroadcastValueProvider(fn: () => Frame[]): void {
    this._broadcastValueProvider = fn;
  }

  /** @internal */
  _setEnqueue(fn: (frame: Frame) => void): void {
    this._enqueueFrame = fn;
    this.tx._setEnqueue(fn);
  }

  /** @internal */
  _authorize(username: string): void {
    this._username = username;
    this._authorized = true;
    this._state = "authorized";
  }

  /** @internal — start key synchronization after auth */
  _startSync(): void {
    this._state = "synchronizing";
    this._serverSyncSent = false;
    this._clientReadyReceived = false;
    this._clientSyncReceived = false;
    this._serverReadySent = false;

    // Send server key registration + SYNC
    const frames = this.tx._buildInitialRegistration();
    if (frames.length > 0) {
      this._serverSyncSent = true;
      if (this._enqueueFrame) {
        for (const f of frames) this._enqueueFrame(f);
      }
    } else {
      this._serverSyncSent = true;
      this._clientReadyReceived = true;
    }
  }

  /** @internal — handle incoming frame from client */
  _handleFrame(frame: Frame): void {
    switch (frame.frameType) {
      case FrameType.ClientKeyRegistration: {
        const keyPath = frame.payload as string;
        this.rx._registerKey(frame.keyId, frame.dataType, keyPath);
        break;
      }

      case FrameType.ClientSync:
        this._clientSyncReceived = true;
        // Send Server READY
        const readyFrame = this._rxHandshake.handleSync();
        this._serverReadySent = true;
        if (this._enqueueFrame) this._enqueueFrame(readyFrame);
        this._checkReady();
        break;

      case FrameType.ClientReady:
        this._clientReadyReceived = true;
        // Send all current TX values
        const valueFrames = this._txHandshake.handleReady();
        if (this._enqueueFrame) {
          for (const vf of valueFrames) this._enqueueFrame(vf);
        }
        // In broadcast mode, also send broadcast values
        if (this._broadcastValueProvider && this._enqueueFrame) {
          const bcastFrames = this._broadcastValueProvider();
          for (const f of bcastFrames) this._enqueueFrame(f);
        }
        this._checkReady();
        break;

      case FrameType.ClientValue:
        if (!this.rx._hasKeyId(frame.keyId)) {
          this._emitError(new DanWSError("UNKNOWN_KEY_ID", `Unknown client key ID: ${frame.keyId}`));
          // Trigger resync
          if (this._enqueueFrame) {
            const resyncFrame: Frame = {
              frameType: FrameType.ServerResyncReq,
              keyId: 0, dataType: DataType.Null, payload: null,
            };
            this._enqueueFrame(resyncFrame);
          }
          break;
        }
        this.rx._receiveValue(frame.keyId, frame.payload);
        break;

      case FrameType.ClientReset:
        this.rx._reset();
        this._clientSyncReceived = false;
        this._serverReadySent = false;
        break;

      case FrameType.ClientResyncReq: {
        // Client wants us to re-register server keys
        const resyncFrames = this._txHandshake.handleResyncReq();
        if (resyncFrames && this._enqueueFrame) {
          for (const f of resyncFrames) this._enqueueFrame(f);
          this._clientReadyReceived = false;
        }
        break;
      }

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

  /** @internal — restore session on reconnect */
  _handleReconnect(): void {
    this._connected = true;
    this._state = "authorized";
  }

  private _checkReady(): void {
    if (this._serverSyncSent && this._clientReadyReceived &&
        (this._clientSyncReceived || !this._serverReadySent)) {
      if (this._clientSyncReceived && this._serverReadySent && this._clientReadyReceived) {
        this._state = "ready";
        this._emit(this._onReady);
      } else if (!this._clientSyncReceived) {
        // Server side done, waiting for client side
        // Will become ready when client SYNC + Server READY completes
      }
    }

    // Simple check: both directions done
    const serverToClientDone = this._serverSyncSent && this._clientReadyReceived;
    const clientToServerDone = this._clientSyncReceived && this._serverReadySent;
    const noClientKeys = !this._clientSyncReceived && !this._serverReadySent;

    if (serverToClientDone && (clientToServerDone || noClientKeys)) {
      if (this._state !== "ready") {
        this._state = "ready";
        this._emit(this._onReady);
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
