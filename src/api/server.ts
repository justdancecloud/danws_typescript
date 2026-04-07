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
import type { TopicInfo } from "./session.js";
import { TopicHandle } from "./topic-handle.js";
import { KeyRegistry } from "../state/key-registry.js";

export type ServerMode = "broadcast" | "principal" | "individual" | "session_topic" | "session_principal_topic";

export interface ServerOptions {
  port?: number;
  server?: HttpServer;
  path?: string;
  mode?: ServerMode;
  session?: { ttl?: number };
  debug?: boolean | ((msg: string, err?: Error) => void);
  flushIntervalMs?: number;
}

interface InternalSession {
  session: DanWebSocketSession;
  ws: WS | null;
  bulkQueue: BulkQueue;
  heartbeat: HeartbeatManager;
  authController: AuthController;
  ttlTimer: ReturnType<typeof setTimeout> | null;
  clientRegistry: KeyRegistry | null;
  clientValues: Map<number, unknown> | null;
}

const BROADCAST_PRINCIPAL = "__broadcast__";

// Topic namespace object
interface TopicNamespace {
  onSubscribe(cb: (session: DanWebSocketSession, topic: TopicHandle) => void): void;
  onUnsubscribe(cb: (session: DanWebSocketSession, topic: TopicHandle) => void): void;
  _onSubscribeCbs: Array<(session: DanWebSocketSession, topic: TopicHandle) => void>;
  _onUnsubscribeCbs: Array<(session: DanWebSocketSession, topic: TopicHandle) => void>;
}

export class DanWebSocketServer {
  readonly mode: ServerMode;
  readonly topic: TopicNamespace;

  private _principals: PrincipalManager;
  private _wss: WSServer;
  private _path: string;
  private _ttl: number;
  private _authEnabled = false;
  private _authTimeout = 5000;
  private _debug: boolean | ((msg: string, err?: Error) => void) = false;
  private _flushIntervalMs: number | undefined;

  private _sessions = new Map<string, InternalSession>();
  private _tmpSessions = new Map<string, InternalSession>();
  private _principalIndex = new Map<string, Set<InternalSession>>();

  // Callbacks (backward compat)
  private _onConnection: Array<(session: DanWebSocketSession) => void> = [];
  private _onAuthorize: Array<(clientUuid: string, token: string) => void> = [];
  private _onSessionExpired: Array<(session: DanWebSocketSession) => void> = [];
  private _onTopicSubscribe: Array<(session: DanWebSocketSession, topic: TopicInfo) => void> = [];
  private _onTopicUnsubscribe: Array<(session: DanWebSocketSession, topicName: string) => void> = [];
  private _onTopicParamsChange: Array<(session: DanWebSocketSession, topic: TopicInfo) => void> = [];

  constructor(options: ServerOptions) {
    if (options.port != null && options.server != null) {
      throw new DanWSError("INVALID_OPTIONS", "Cannot specify both port and server");
    }
    if (options.port == null && options.server == null) {
      throw new DanWSError("INVALID_OPTIONS", "Must specify either port or server");
    }

    let mode = options.mode ?? "principal";
    if (mode === "individual") mode = "principal";
    this.mode = mode;

    this._path = options.path ?? "/";
    this._ttl = options.session?.ttl ?? 600_000;
    this._debug = options.debug ?? false;
    this._flushIntervalMs = options.flushIntervalMs;

    // Topic namespace
    const ns: TopicNamespace = {
      _onSubscribeCbs: [],
      _onUnsubscribeCbs: [],
      onSubscribe(cb) { ns._onSubscribeCbs.push(cb); },
      onUnsubscribe(cb) { ns._onUnsubscribeCbs.push(cb); },
    };
    this.topic = ns;

    this._principals = new PrincipalManager();
    if (!this._isTopicMode) {
      this._principals._setOnNewPrincipal((ptx) => this._bindPrincipalTX(ptx));
    }

    if (options.port != null) {
      this._wss = new WSServer({ port: options.port, path: this._path });
    } else {
      this._wss = new WSServer({ server: options.server!, path: this._path });
    }

    this._wss.on("connection", (ws) => this._handleConnection(ws));
  }

  private get _isTopicMode(): boolean {
    return this.mode === "session_topic" || this.mode === "session_principal_topic";
  }

  // ──── Broadcast mode API ────

  set(key: string, value: unknown): void {
    this._assertMode("broadcast", "set");
    this._principals.principal(BROADCAST_PRINCIPAL).set(key, value);
  }

  get(key: string): unknown {
    this._assertMode("broadcast", "get");
    return this._principals.principal(BROADCAST_PRINCIPAL).get(key);
  }

  get keys(): string[] {
    if (this.mode !== "broadcast") return [];
    return this._principals.principal(BROADCAST_PRINCIPAL).keys;
  }

  clear(key: string): void;
  clear(): void;
  clear(key?: string): void {
    this._assertMode("broadcast", "clear");
    if (key !== undefined) {
      this._principals.principal(BROADCAST_PRINCIPAL).clear(key);
    } else {
      this._principals.principal(BROADCAST_PRINCIPAL).clear();
    }
  }

  // ──── Principal mode API ────

  principal(name: string): PrincipalTX {
    if (this.mode !== "principal" && this.mode !== "session_principal_topic") {
      throw new DanWSError("INVALID_MODE", `server.principal() is only available in principal/session_principal_topic mode.`);
    }
    return this._principals.principal(name);
  }

  get principals(): string[] {
    return this._principals.principals;
  }

  // ──── Common API ────

  enableAuthorization(enabled: boolean, options?: { timeout?: number }): void {
    this._authEnabled = enabled;
    if (options?.timeout != null) this._authTimeout = options.timeout;
  }

  authorize(clientUuid: string, token: string, principal: string): void {
    const internal = this._tmpSessions.get(clientUuid);
    if (!internal) return;

    this._tmpSessions.delete(clientUuid);
    internal.authController.accept(principal);
    internal.session._authorize(principal);

    this._sendFrame(internal, {
      frameType: FrameType.AuthOk,
      keyId: 0, dataType: DataType.Null, payload: null,
    });

    this._sessions.set(clientUuid, internal);
    this._activateSession(internal, principal);
  }

  reject(clientUuid: string, reason?: string): void {
    const internal = this._tmpSessions.get(clientUuid);
    if (!internal) return;

    this._tmpSessions.delete(clientUuid);
    this._sendFrame(internal, {
      frameType: FrameType.AuthFail,
      keyId: 0, dataType: DataType.String, payload: reason ?? "Authorization rejected",
    });

    if (internal.ws) {
      const ws = internal.ws;
      setTimeout(() => { try { ws.close(); } catch {} }, 50);
    }
  }

  getSession(uuid: string): DanWebSocketSession | null {
    return this._sessions.get(uuid)?.session ?? null;
  }

  getSessionsByPrincipal(principal: string): DanWebSocketSession[] {
    const effectivePrincipal = this.mode === "broadcast" ? BROADCAST_PRINCIPAL : principal;
    const set = this._principalIndex.get(effectivePrincipal);
    if (!set) return [];
    const result: DanWebSocketSession[] = [];
    for (const internal of set) {
      result.push(internal.session);
    }
    return result;
  }

  isConnected(uuid: string): boolean {
    return this._sessions.get(uuid)?.session.connected ?? false;
  }

  close(): void {
    for (const internal of this._sessions.values()) {
      internal.session._disposeAllTopicHandles();
      internal.session._handleDisconnect();
      internal.heartbeat.stop();
      internal.bulkQueue.dispose();
      if (internal.ttlTimer) clearTimeout(internal.ttlTimer);
      if (internal.ws) { try { internal.ws.close(1001, "Server shutting down"); } catch {} }
    }
    for (const internal of this._tmpSessions.values()) {
      internal.authController.clearTimeout();
      if (internal.ws) internal.ws.close();
    }
    this._sessions.clear();
    this._tmpSessions.clear();
    this._principalIndex.clear();
    this._wss.close();
  }

  // ──── Event registration (backward compat) ────

  onConnection(cb: (session: DanWebSocketSession) => void): void { this._onConnection.push(cb); }
  onAuthorize(cb: (clientUuid: string, token: string) => void): void { this._onAuthorize.push(cb); }
  onSessionExpired(cb: (session: DanWebSocketSession) => void): void { this._onSessionExpired.push(cb); }
  onTopicSubscribe(cb: (session: DanWebSocketSession, topic: TopicInfo) => void): void { this._onTopicSubscribe.push(cb); }
  onTopicUnsubscribe(cb: (session: DanWebSocketSession, topicName: string) => void): void { this._onTopicUnsubscribe.push(cb); }
  onTopicParamsChange(cb: (session: DanWebSocketSession, topic: TopicInfo) => void): void { this._onTopicParamsChange.push(cb); }

  // ──── Mode guard ────

  private _log(msg: string, err?: Error): void {
    if (typeof this._debug === "function") this._debug(msg, err);
    else if (this._debug) console.warn(`[dan-ws] ${msg}`, err ?? "");
  }

  private _assertMode(expected: string, method: string): void {
    if (this.mode !== expected) {
      throw new DanWSError("INVALID_MODE", `server.${method}() is only available in ${expected} mode.`);
    }
  }

  // ──── Internal: Principal index management ────

  private _indexAddSession(principal: string, internal: InternalSession): void {
    let set = this._principalIndex.get(principal);
    if (!set) { set = new Set(); this._principalIndex.set(principal, set); }
    set.add(internal);
  }

  private _indexRemoveSession(principal: string, internal: InternalSession): void {
    const set = this._principalIndex.get(principal);
    if (set) {
      set.delete(internal);
      if (set.size === 0) this._principalIndex.delete(principal);
    }
  }

  private _getSessionsForPrincipal(principalName: string): Iterable<InternalSession> {
    return this._principalIndex.get(principalName) ?? [];
  }

  // ──── Internal: PrincipalTX binding ────

  private _bindPrincipalTX(ptx: PrincipalTX): void {
    ptx._onValue((frame) => {
      for (const internal of this._getSessionsForPrincipal(ptx.name)) {
        if (internal.session.state === "ready" &&
            internal.ws && internal.ws.readyState === WS.OPEN) {
          internal.bulkQueue.enqueue(frame);
        }
      }
    });

    ptx._onIncremental((keyFrame, syncFrame, valueFrame) => {
      for (const internal of this._getSessionsForPrincipal(ptx.name)) {
        if (internal.session.state === "ready" &&
            internal.ws && internal.ws.readyState === WS.OPEN) {
          internal.bulkQueue.enqueue(keyFrame);
          internal.bulkQueue.enqueue(syncFrame);
          internal.bulkQueue.enqueue(valueFrame);
        }
      }
    });

    ptx._onResync(() => {
      for (const internal of this._getSessionsForPrincipal(ptx.name)) {
        if (internal.session.connected &&
            internal.ws && internal.ws.readyState === WS.OPEN) {
          internal.bulkQueue.enqueue({
            frameType: FrameType.ServerReset,
            keyId: 0, dataType: DataType.Null, payload: null,
          });
          for (const f of ptx._buildKeyFrames()) internal.bulkQueue.enqueue(f);
        }
      }
    });
  }

  // ──── Internal: Connection handling ────

  private _handleConnection(ws: WS): void {
    const parser = createStreamParser();
    let identified = false;
    let clientUuid = "";

    parser.onHeartbeat(() => {
      const internal = this._sessions.get(clientUuid) ?? this._tmpSessions.get(clientUuid);
      if (internal) {
        internal.heartbeat.received();
        // No echo — server sends its own heartbeat on a timer via HeartbeatManager
      }
    });

    parser.onFrame((frame) => {
      if (!identified) {
        if (frame.frameType !== FrameType.Identify) { ws.close(); return; }
        const payload = frame.payload;
        if (payload instanceof Uint8Array && (payload.length === 16 || payload.length === 18)) {
          clientUuid = bytesToUuid(payload.subarray(0, 16));
        } else { ws.close(); return; }

        identified = true;
        this._handleIdentified(ws, clientUuid);
        return;
      }

      // Auth frame
      if (frame.frameType === FrameType.Auth) {
        const internal = this._tmpSessions.get(clientUuid);
        if (internal && this._authEnabled) {
          const token = frame.payload as string;
          internal.authController.handleAuth(token);
          for (const cb of this._onAuthorize) { try { cb(clientUuid, token); } catch (e) { this._log("onAuthorize callback error", e as Error); } }
        }
        return;
      }

      // Client→Server topic frames
      if (this._isTopicMode) {
        const internal = this._sessions.get(clientUuid);
        if (internal) {
          if (frame.frameType === FrameType.ClientReset ||
              frame.frameType === FrameType.ClientKeyRegistration ||
              frame.frameType === FrameType.ClientValue ||
              frame.frameType === FrameType.ClientSync) {
            this._handleClientTopicFrame(internal, frame);
            return;
          }
        }
      }

      // Route to session handler
      const internal = this._sessions.get(clientUuid);
      if (internal) internal.session._handleFrame(frame);
    });

    parser.onError((err) => { this._log("Stream parser error", err instanceof Error ? err : new Error(String(err))); });

    ws.on("message", (data: Buffer | ArrayBuffer) => {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      parser.feed(bytes);
    });

    ws.on("close", () => { if (clientUuid) this._handleSessionDisconnect(clientUuid); });
  }

  private _handleIdentified(ws: WS, clientUuid: string): void {
    const existing = this._sessions.get(clientUuid);
    if (existing) {
      if (existing.ws && existing.ws.readyState === WS.OPEN) existing.ws.close();
      if (existing.ttlTimer) { clearTimeout(existing.ttlTimer); existing.ttlTimer = null; }

      existing.ws = ws;
      existing.session._handleReconnect();
      existing.heartbeat.start();
      existing.bulkQueue.onFlush((data) => {
        if (existing.ws && existing.ws.readyState === WS.OPEN) existing.ws.send(data);
      });

      if (this._authEnabled) {
        this._tmpSessions.set(clientUuid, existing);
        this._sessions.delete(clientUuid);
        existing.authController.reset();
        existing.authController.handleIdentify(uuidToBytes(clientUuid));
        existing.authController.startTimeout(() => { this._tmpSessions.delete(clientUuid); ws.close(); });
      } else {
        const principal = existing.session.principal ?? BROADCAST_PRINCIPAL;
        existing.session._authorize(principal);
        this._activateSession(existing, principal);
      }
      return;
    }

    const session = new DanWebSocketSession(clientUuid);
    const bulkQueue = new BulkQueue(this._flushIntervalMs);
    const heartbeat = new HeartbeatManager();
    const authController = new AuthController({ required: this._authEnabled, timeout: this._authTimeout });

    authController.handleIdentify(uuidToBytes(clientUuid));

    const internal: InternalSession = {
      session, ws, bulkQueue, heartbeat, authController,
      ttlTimer: null, clientRegistry: null, clientValues: null,
    };

    session._setEnqueue((f) => bulkQueue.enqueue(f));
    bulkQueue.onFlush((data) => { if (internal.ws && internal.ws.readyState === WS.OPEN) internal.ws.send(data); });
    heartbeat.onSend((data) => { if (internal.ws && internal.ws.readyState === WS.OPEN) internal.ws.send(data); });
    heartbeat.onTimeout(() => { this._handleSessionDisconnect(clientUuid); });
    heartbeat.start();

    if (this._authEnabled) {
      this._tmpSessions.set(clientUuid, internal);
      authController.startTimeout(() => { this._tmpSessions.delete(clientUuid); ws.close(); });
    } else {
      const defaultPrincipal = this.mode === "broadcast" ? BROADCAST_PRINCIPAL : "default";
      session._authorize(defaultPrincipal);
      this._sessions.set(clientUuid, internal);
      this._activateSession(internal, defaultPrincipal);
    }
  }

  private _activateSession(internal: InternalSession, principal: string): void {
    if (this._isTopicMode) {
      internal.session._bindSessionTX((f) => internal.bulkQueue.enqueue(f));
      for (const cb of this._onConnection) { try { cb(internal.session); } catch (e) { this._log("onConnection callback error", e as Error); } }
      internal.bulkQueue.enqueue({
        frameType: FrameType.ServerSync,
        keyId: 0, dataType: DataType.Null, payload: null,
      });
    } else {
      const effectivePrincipal = this.mode === "broadcast" ? BROADCAST_PRINCIPAL : principal;
      const ptx = this._principals.principal(effectivePrincipal);
      this._principals._addSession(effectivePrincipal);
      this._indexAddSession(effectivePrincipal, internal);

      internal.session._setTxProviders(
        () => ptx._buildKeyFrames(),
        () => ptx._buildValueFrames(),
      );

      for (const cb of this._onConnection) { try { cb(internal.session); } catch (e) { this._log("onConnection callback error", e as Error); } }
      internal.session._startSync();
    }
  }

  // ──── Internal: Client→Server topic frame handling ────

  private _handleClientTopicFrame(internal: InternalSession, frame: Frame): void {
    switch (frame.frameType) {
      case FrameType.ClientReset:
        if (internal.clientRegistry) internal.clientRegistry.clear();
        else internal.clientRegistry = new KeyRegistry();
        if (internal.clientValues) internal.clientValues.clear();
        else internal.clientValues = new Map();
        break;

      case FrameType.ClientKeyRegistration: {
        if (!internal.clientRegistry) internal.clientRegistry = new KeyRegistry();
        internal.clientRegistry.registerOne(frame.keyId, frame.payload as string, frame.dataType);
        break;
      }

      case FrameType.ClientValue: {
        if (!internal.clientValues) internal.clientValues = new Map();
        internal.clientValues.set(frame.keyId, frame.payload);
        break;
      }

      case FrameType.ClientSync: {
        this._processTopicSync(internal);
        break;
      }
    }
  }

  private _processTopicSync(internal: InternalSession): void {
    const session = internal.session;

    const newTopics = new Map<string, Record<string, unknown>>();
    const nameToIndex = new Map<string, number>(); // topicName → client wire index

    if (internal.clientRegistry && internal.clientValues) {
      const indexToName = new Map<string, string>();

      for (const path of internal.clientRegistry.paths) {
        const match = path.match(/^topic\.(\d+)\.name$/);
        if (match) {
          const entry = internal.clientRegistry.getByPath(path);
          if (entry) {
            const topicName = internal.clientValues.get(entry.keyId) as string;
            if (topicName) {
              const idx = parseInt(match[1]);
              indexToName.set(match[1], topicName);
              nameToIndex.set(topicName, idx);
              if (!newTopics.has(topicName)) newTopics.set(topicName, {});
            }
          }
        }
      }

      for (const path of internal.clientRegistry.paths) {
        const match = path.match(/^topic\.(\d+)\.param\.(.+)$/);
        if (match) {
          const topicName = indexToName.get(match[1]);
          if (topicName) {
            const entry = internal.clientRegistry.getByPath(path);
            if (entry) {
              const value = internal.clientValues.get(entry.keyId);
              if (value !== undefined) newTopics.get(topicName)![match[2]] = value;
            }
          }
        }
      }
    }

    // Diff: unsubscribed
    const oldTopics = new Set(session.topics);

    for (const oldName of oldTopics) {
      if (!newTopics.has(oldName)) {
        // Fire new API callbacks
        const handle = session.getTopicHandle(oldName);
        if (handle) {
          for (const cb of this.topic._onUnsubscribeCbs) { try { cb(session, handle); } catch (e) { this._log("topic.onUnsubscribe callback error", e as Error); } }
        }
        // Fire backward compat callbacks
        for (const cb of this._onTopicUnsubscribe) { try { cb(session, oldName); } catch (e) { this._log("onTopicUnsubscribe callback error", e as Error); } }
        // Remove
        session._removeTopicHandle(oldName);
        session._removeTopic(oldName);
      }
    }

    // Diff: new / changed
    for (const [name, params] of newTopics) {
      const existingHandle = session.getTopicHandle(name);
      const existingInfo = session.topic(name);

      if (!existingHandle && !existingInfo) {
        // New subscription — create TopicHandle with client's wire index
        const clientIdx = nameToIndex.get(name) ?? session._nextTopicIndex;
        const handle = session._createTopicHandle(name, params, clientIdx);
        // Fire new API callbacks
        for (const cb of this.topic._onSubscribeCbs) { try { cb(session, handle); } catch (e) { this._log("topic.onSubscribe callback error", e as Error); } }
        // Fire backward compat callbacks
        for (const cb of this._onTopicSubscribe) { try { cb(session, { name, params }); } catch (e) { this._log("onTopicSubscribe callback error", e as Error); } }
      } else {
        // Check params changed
        const oldParams = existingHandle ? existingHandle.params : existingInfo?.params;
        const changed = JSON.stringify(oldParams) !== JSON.stringify(params);
        if (changed) {
          // Update TopicHandle (auto fires callback with ChangedParamsEvent)
          if (existingHandle) {
            existingHandle._updateParams(params);
          }
          // Update backward compat
          session._updateTopicParams(name, params);
          for (const cb of this._onTopicParamsChange) { try { cb(session, { name, params }); } catch (e) { this._log("onTopicParamsChange callback error", e as Error); } }
        }
      }
    }
  }

  // ──── Internal: Session disconnect ────

  private _handleSessionDisconnect(uuid: string): void {
    const internal = this._sessions.get(uuid);
    if (!internal) {
      const tmp = this._tmpSessions.get(uuid);
      if (tmp) { this._tmpSessions.delete(uuid); tmp.heartbeat.stop(); }
      return;
    }

    if (!internal.session.connected) return;

    internal.session._disposeAllTopicHandles();
    internal.session._handleDisconnect();
    internal.heartbeat.stop();
    internal.bulkQueue.clear();
    internal.ws = null;

    internal.ttlTimer = setTimeout(() => {
      this._sessions.delete(uuid);
      const principal = internal.session.principal;
      if (principal && !this._isTopicMode) {
        const effectivePrincipal = this.mode === "broadcast" ? BROADCAST_PRINCIPAL : principal;
        this._principals._removeSession(effectivePrincipal);
        this._indexRemoveSession(effectivePrincipal, internal);
      }
      for (const cb of this._onSessionExpired) { try { cb(internal.session); } catch (e) { this._log("onSessionExpired callback error", e as Error); } }
    }, this._ttl);
  }

  private _sendFrame(internal: InternalSession, frame: Frame): void {
    if (internal.ws && internal.ws.readyState === WS.OPEN) internal.ws.send(encode(frame));
  }
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
