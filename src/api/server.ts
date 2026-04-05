import { WebSocketServer as WSServer, WebSocket as WS } from "ws";
import type { Server as HttpServer } from "http";
import { DataType, FrameType, DanWSError } from "../protocol/types.js";
import type { Frame } from "../protocol/types.js";
import { encode, encodeHeartbeat } from "../protocol/codec.js";
import { createStreamParser } from "../protocol/stream-parser.js";
import { AuthController } from "../state/auth-controller.js";
import { BulkQueue } from "../connection/bulk-queue.js";
import { HeartbeatManager } from "../connection/heartbeat-manager.js";
import { DanWebSocketSession } from "./session.js";
import { PrincipalManager, PrincipalTX } from "./principal-store.js";

export interface ServerOptions {
  port?: number;
  server?: HttpServer;
  path?: string;
  session?: { ttl?: number };
}

interface InternalSession {
  session: DanWebSocketSession;
  ws: WS | null;
  bulkQueue: BulkQueue;
  heartbeat: HeartbeatManager;
  authController: AuthController;
  ttlTimer: ReturnType<typeof setTimeout> | null;
}

export class DanWebSocketServer {
  private _principals: PrincipalManager;

  private _wss: WSServer;
  private _path: string;
  private _ttl: number;
  private _authEnabled = false;
  private _authTimeout = 5000;

  // Sessions
  private _sessions = new Map<string, InternalSession>();
  private _tmpSessions = new Map<string, InternalSession>();

  // Callbacks
  private _onConnection: Array<(session: DanWebSocketSession) => void> = [];
  private _onAuthorize: Array<(clientUuid: string, token: string) => void> = [];
  private _onSessionExpired: Array<(session: DanWebSocketSession) => void> = [];

  constructor(options: ServerOptions) {
    if (options.port != null && options.server != null) {
      throw new DanWSError("INVALID_OPTIONS", "Cannot specify both port and server");
    }
    if (options.port == null && options.server == null) {
      throw new DanWSError("INVALID_OPTIONS", "Must specify either port or server");
    }

    this._path = options.path ?? "/";
    this._ttl = options.session?.ttl ?? 600_000;

    this._principals = new PrincipalManager();
    this._principals._setOnNewPrincipal((ptx) => this._bindPrincipalTX(ptx));

    // Create WebSocket server
    if (options.port != null) {
      this._wss = new WSServer({ port: options.port, path: this._path });
    } else {
      this._wss = new WSServer({ server: options.server!, path: this._path });
    }

    this._wss.on("connection", (ws) => this._handleConnection(ws));
  }

  principal(name: string): PrincipalTX {
    return this._principals.principal(name);
  }

  enableAuthorization(enabled: boolean, options?: { timeout?: number }): void {
    this._authEnabled = enabled;
    if (options?.timeout != null) {
      this._authTimeout = options.timeout;
    }
  }

  authorize(clientUuid: string, token: string, principal: string): void {
    const internal = this._tmpSessions.get(clientUuid);
    if (!internal) return;

    this._tmpSessions.delete(clientUuid);
    internal.authController.accept(principal);
    internal.session._authorize(principal);

    // Send AUTH_OK
    const authOkFrame: Frame = {
      frameType: FrameType.AuthOk,
      keyId: 0, dataType: DataType.Null, payload: null,
    };
    this._sendFrame(internal, authOkFrame);

    this._sessions.set(clientUuid, internal);
    this._activateSession(internal, principal);
  }

  reject(clientUuid: string, reason?: string): void {
    const internal = this._tmpSessions.get(clientUuid);
    if (!internal) return;

    this._tmpSessions.delete(clientUuid);

    const authFailFrame: Frame = {
      frameType: FrameType.AuthFail,
      keyId: 0, dataType: DataType.String, payload: reason ?? "Authorization rejected",
    };
    this._sendFrame(internal, authFailFrame);

    if (internal.ws) {
      const ws = internal.ws;
      setTimeout(() => { try { ws.close(); } catch {} }, 50);
    }
  }

  getSession(uuid: string): DanWebSocketSession | null {
    const internal = this._sessions.get(uuid);
    return internal?.session ?? null;
  }

  getSessionsByPrincipal(principal: string): DanWebSocketSession[] {
    const result: DanWebSocketSession[] = [];
    for (const internal of this._sessions.values()) {
      if (internal.session.principal === principal) {
        result.push(internal.session);
      }
    }
    return result;
  }

  isConnected(uuid: string): boolean {
    const internal = this._sessions.get(uuid);
    return internal?.session.connected ?? false;
  }

  close(): void {
    for (const internal of this._sessions.values()) {
      internal.session._handleDisconnect();
      internal.heartbeat.stop();
      internal.bulkQueue.dispose();
      if (internal.ttlTimer) clearTimeout(internal.ttlTimer);
    }
    for (const internal of this._tmpSessions.values()) {
      internal.authController.clearTimeout();
      if (internal.ws) internal.ws.close();
    }
    this._sessions.clear();
    this._tmpSessions.clear();
    this._wss.close();
  }

  // ──── Event registration ────

  onConnection(cb: (session: DanWebSocketSession) => void): void { this._onConnection.push(cb); }
  onAuthorize(cb: (clientUuid: string, token: string) => void): void { this._onAuthorize.push(cb); }
  onSessionExpired(cb: (session: DanWebSocketSession) => void): void { this._onSessionExpired.push(cb); }

  // ──── Internal ────

  /**
   * Bind a PrincipalTX so that set() broadcasts to all sessions of that principal.
   */
  private _bindPrincipalTX(ptx: PrincipalTX): void {
    ptx._onValue((frame) => {
      for (const internal of this._sessions.values()) {
        if (internal.session.principal === ptx.name &&
            internal.session.state === "ready" &&
            internal.ws && internal.ws.readyState === WS.OPEN) {
          internal.bulkQueue.enqueue(frame);
        }
      }
    });

    ptx._onResync(() => {
      // New key or type change — re-sync all sessions of this principal
      for (const internal of this._sessions.values()) {
        if (internal.session.principal === ptx.name &&
            internal.session.connected &&
            internal.ws && internal.ws.readyState === WS.OPEN) {
          // Send RESET + new keys + SYNC → session waits for READY → sends values
          const resetFrame: Frame = {
            frameType: FrameType.ServerReset,
            keyId: 0, dataType: DataType.Null, payload: null,
          };
          internal.bulkQueue.enqueue(resetFrame);
          const keyFrames = ptx._buildKeyFrames();
          for (const f of keyFrames) internal.bulkQueue.enqueue(f);
        }
      }
    });
  }

  private _handleConnection(ws: WS): void {
    const parser = createStreamParser();
    let identified = false;
    let clientUuid = "";

    parser.onHeartbeat(() => {
      const internal = this._sessions.get(clientUuid) ?? this._tmpSessions.get(clientUuid);
      if (internal) {
        internal.heartbeat.received();
        if (internal.ws && internal.ws.readyState === WS.OPEN) {
          internal.ws.send(encodeHeartbeat());
        }
      }
    });

    parser.onFrame((frame) => {
      if (!identified) {
        if (frame.frameType !== FrameType.Identify) {
          ws.close();
          return;
        }

        const payload = frame.payload;
        if (payload instanceof Uint8Array && payload.length === 16) {
          clientUuid = bytesToUuid(payload);
        } else {
          ws.close();
          return;
        }

        identified = true;

        // Check for existing session (reconnect)
        const existing = this._sessions.get(clientUuid);
        if (existing) {
          if (existing.ws && existing.ws.readyState === WS.OPEN) {
            existing.ws.close();
          }
          if (existing.ttlTimer) {
            clearTimeout(existing.ttlTimer);
            existing.ttlTimer = null;
          }

          existing.ws = ws;
          existing.session._handleReconnect();
          existing.heartbeat.start();

          existing.bulkQueue.onFlush((data) => {
            if (existing.ws && existing.ws.readyState === WS.OPEN) {
              existing.ws.send(data);
            }
          });

          if (this._authEnabled) {
            this._tmpSessions.set(clientUuid, existing);
            this._sessions.delete(clientUuid);
            existing.authController.reset();
            existing.authController.handleIdentify(uuidToBytes(clientUuid));
            existing.authController.startTimeout(() => {
              this._tmpSessions.delete(clientUuid);
              ws.close();
            });
          } else {
            const principal = existing.session.principal ?? "";
            existing.session._authorize(principal);
            this._activateSession(existing, principal);
          }
          return;
        }

        // New session
        const session = new DanWebSocketSession(clientUuid);
        const bulkQueue = new BulkQueue();
        const heartbeat = new HeartbeatManager();
        const authController = new AuthController({
          required: this._authEnabled,
          timeout: this._authTimeout,
        });

        authController.handleIdentify(uuidToBytes(clientUuid));

        const internal: InternalSession = {
          session, ws, bulkQueue, heartbeat, authController, ttlTimer: null,
        };

        session._setEnqueue((f) => bulkQueue.enqueue(f));

        bulkQueue.onFlush((data) => {
          if (internal.ws && internal.ws.readyState === WS.OPEN) {
            internal.ws.send(data);
          }
        });

        heartbeat.onSend((data) => {
          if (internal.ws && internal.ws.readyState === WS.OPEN) {
            internal.ws.send(data);
          }
        });

        heartbeat.onTimeout(() => {
          this._handleSessionDisconnect(clientUuid);
        });

        heartbeat.start();

        if (this._authEnabled) {
          this._tmpSessions.set(clientUuid, internal);
          authController.startTimeout(() => {
            this._tmpSessions.delete(clientUuid);
            ws.close();
          });
        } else {
          // No auth — use empty principal, activate immediately
          session._authorize("default");
          this._sessions.set(clientUuid, internal);
          this._activateSession(internal, "default");
        }

        return;
      }

      // Auth frame
      if (frame.frameType === FrameType.Auth) {
        const internal = this._tmpSessions.get(clientUuid);
        if (internal && this._authEnabled) {
          const token = frame.payload as string;
          internal.authController.handleAuth(token);
          for (const cb of this._onAuthorize) {
            try { cb(clientUuid, token); } catch {}
          }
        }
        return;
      }

      // Route to session
      const internal = this._sessions.get(clientUuid);
      if (internal) {
        internal.session._handleFrame(frame);
      }
    });

    parser.onError(() => {});

    ws.on("message", (data: Buffer | ArrayBuffer) => {
      const bytes = data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      parser.feed(bytes);
    });

    ws.on("close", () => {
      if (clientUuid) {
        this._handleSessionDisconnect(clientUuid);
      }
    });
  }

  private _activateSession(internal: InternalSession, principal: string): void {
    // Get or create principal TX
    const ptx = this._principals.principal(principal);

    // Bind session to principal's shared TX
    internal.session._setTxProviders(
      () => ptx._buildKeyFrames(),
      () => ptx._buildValueFrames(),
    );

    for (const cb of this._onConnection) {
      try { cb(internal.session); } catch {}
    }

    // Start key sync
    internal.session._startSync();
  }

  private _handleSessionDisconnect(uuid: string): void {
    const internal = this._sessions.get(uuid);
    if (!internal) {
      const tmp = this._tmpSessions.get(uuid);
      if (tmp) {
        this._tmpSessions.delete(uuid);
        tmp.heartbeat.stop();
      }
      return;
    }

    if (!internal.session.connected) return;

    internal.session._handleDisconnect();
    internal.heartbeat.stop();
    internal.bulkQueue.clear();
    internal.ws = null;

    // Start TTL timer
    internal.ttlTimer = setTimeout(() => {
      this._sessions.delete(uuid);
      for (const cb of this._onSessionExpired) {
        try { cb(internal.session); } catch {}
      }
    }, this._ttl);
  }

  private _sendFrame(internal: InternalSession, frame: Frame): void {
    if (internal.ws && internal.ws.readyState === WS.OPEN) {
      internal.ws.send(encode(frame));
    }
  }
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
