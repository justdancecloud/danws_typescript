import { DataType, FrameType, DanWSError } from "../protocol/types.js";
import type { Frame } from "../protocol/types.js";

export type SessionState = "pending" | "authorized" | "synchronizing" | "ready" | "disconnected";

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

  // Provider for TX frames (from principal shared state)
  private _txKeyFrameProvider: (() => Frame[]) | null = null;
  private _txValueFrameProvider: (() => Frame[]) | null = null;

  // Sync tracking (server→client only)
  private _serverSyncSent = false;
  private _clientReadyReceived = false;

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

  // ──── Internal methods ────

  /** @internal */
  _setEnqueue(fn: (frame: Frame) => void): void {
    this._enqueueFrame = fn;
  }

  /** @internal */
  _setTxProviders(
    keyFrames: () => Frame[],
    valueFrames: () => Frame[],
  ): void {
    this._txKeyFrameProvider = keyFrames;
    this._txValueFrameProvider = valueFrames;
  }

  /** @internal */
  _authorize(principal: string): void {
    this._principal = principal;
    this._authorized = true;
    this._state = "authorized";
  }

  /** @internal — start server→client key synchronization */
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
        // No keys — go straight to ready
        this._state = "ready";
        this._emit(this._onReady);
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
        // Send all current values from principal's shared state
        if (this._txValueFrameProvider && this._enqueueFrame) {
          const valueFrames = this._txValueFrameProvider();
          for (const vf of valueFrames) this._enqueueFrame(vf);
        }
        if (this._serverSyncSent) {
          this._state = "ready";
          this._emit(this._onReady);
        }
        break;

      case FrameType.ClientResyncReq:
        // Re-send principal's TX keys
        if (this._txKeyFrameProvider && this._enqueueFrame) {
          const resetFrame: Frame = {
            frameType: FrameType.ServerReset,
            keyId: 0, dataType: DataType.Null, payload: null,
          };
          this._enqueueFrame(resetFrame);
          const frames = this._txKeyFrameProvider();
          for (const f of frames) this._enqueueFrame(f);
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

  private _emit<T extends unknown[]>(callbacks: Array<(...args: T) => void>, ...args: T): void {
    for (const cb of callbacks) {
      try { cb(...args); } catch {}
    }
  }

  private _emitError(err: DanWSError): void {
    this._emit(this._onError, err);
  }
}
