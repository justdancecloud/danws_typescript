# Architecture

## Overview

dan-websocket is a server-to-client state synchronization library. The server holds state and pushes changes to connected clients in real-time using a custom binary protocol (DanProtocol v3.3).

```
Server                          Wire                         Client
┌──────────────┐          ┌──────────────┐          ┌──────────────┐
│ set("price", │  binary  │  DLE-framed  │  binary  │ data.price   │
│   {btc:67k}) │ ──────→  │   frames     │ ──────→  │   .btc       │
│              │          │  (only diff)  │          │   → 67000    │
└──────────────┘          └──────────────┘          └──────────────┘
```

## Layer Architecture

```
┌─────────────────────────────────────────────┐
│  API Layer                                   │
│  server.ts / client.ts / session.ts          │
│  principal-store.ts / topic-handle.ts        │
├─────────────────────────────────────────────┤
│  State Layer                                 │
│  flat-state-manager.ts (flatten + diff)      │
│  array-diff.ts (shift detection)             │
│  state-proxy.ts (Proxy reconstruction)       │
├─────────────────────────────────────────────┤
│  Connection Layer                            │
│  bulk-queue.ts (batch + dedup)               │
│  heartbeat-manager.ts (10s/15s)              │
│  reconnect-engine.ts (backoff + jitter)      │
├─────────────────────────────────────────────┤
│  Protocol Layer                              │
│  codec.ts (encode/decode)                    │
│  stream-parser.ts (DLE state machine)        │
│  serializer.ts (13 types)                    │
│  types.ts (Frame, DataType, FrameType)       │
└─────────────────────────────────────────────┘
```

## Data Flow: Server → Client

### 1. `server.set(key, value)`

```
set("user", {name:"Alice", score:100})
    │
    ▼
FlatStateManager.set()
    │
    ├─ shouldFlatten? → flattenValue()
    │   "user.name" = "Alice"
    │   "user.score" = 100
    │
    ├─ Array? → detectArrayShiftBoth()
    │   shift detected → ARRAY_SHIFT_LEFT/RIGHT frame
    │
    ├─ Per leaf → _setLeaf()
    │   ├─ New key? → KeyRegistration + ServerSync + Value (3 frames)
    │   ├─ Type changed? → trigger full resync
    │   └─ Value changed? → ServerValue frame (1 frame)
    │       Value same? → skip (dedup)
    │
    ▼
BulkQueue.enqueue(frame)
    │
    ├─ ServerValue dedup (same keyId in batch → keep latest)
    ├─ Batched for 100ms (configurable flushIntervalMs)
    │
    ▼
flush() → Codec.encodeBatch(frames) + SERVER_FLUSH_END
    │
    ▼
WebSocket.send(binary)
```

### 2. Client receives binary

```
WebSocket.onmessage(binary)
    │
    ▼
StreamParser.feed(chunk)
    │ DLE state machine: IDLE → DLE STX → IN_FRAME → DLE ETX
    │
    ▼
parseFrame(body) → Frame { frameType, keyId, dataType, payload }
    │
    ▼
client._handleFrame(frame)
    │
    ├─ ServerKeyRegistration → registry.register(keyId, path, type)
    ├─ ServerSync → send CLIENT_READY
    ├─ ServerValue → store[keyId] = payload
    │   ├─ topic wire key (t.0.xxx)? → topicHandle.notify()
    │   └─ global key? → onReceive callbacks
    ├─ ArrayShiftLeft/Right → shift store values in-place
    ├─ ServerFlushEnd → onUpdate callback (once per batch)
    └─ ServerReset → clear registry + store
```

### 3. Client reads data

```
client.data.user.name
    │
    ▼
Proxy.get("user")
    │ hasChildren("user.") → true
    │
    ▼
createStateProxy(getter, keysFn, "user")
    │
    ▼
Proxy.get("name")
    │ getter("user.name") → "Alice"
```

## Connection Lifecycle

### Handshake (no auth)

```
Client                              Server
  │                                    │
  │──── IDENTIFY (UUID + v3.3) ───────→│
  │                                    │ createSession(uuid)
  │                                    │ activateSession()
  │←── ServerKeyRegistration ×N ──────│
  │←── ServerSync ────────────────────│
  │──── ClientReady ──────────────────→│
  │←── ServerValue ×N ────────────────│
  │←── SERVER_FLUSH_END ──────────────│
  │         [state: READY]             │
```

### Handshake (with auth)

```
Client                              Server
  │                                    │
  │──── IDENTIFY (UUID + v3.3) ───────→│
  │                                    │ tmpSessions[uuid]
  │──── AUTH (token) ─────────────────→│
  │                                    │ onAuthorize(uuid, token)
  │                                    │ authorize(uuid, token, principal)
  │←── AUTH_OK ───────────────────────│
  │←── ServerKeyRegistration ×N ──────│
  │←── ServerSync ────────────────────│
  │──── ClientReady ──────────────────→│
  │←── ServerValue ×N ────────────────│
  │         [state: READY]             │
```

### Topic Subscription

```
Client                              Server
  │                                    │
  │──── ClientReset ──────────────────→│
  │──── ClientKeyRegistration ×N ─────→│  (topic.0.name, topic.0.param.x)
  │──── ClientValue ×N ──────────────→│  (topic names + param values)
  │──── ClientSync ───────────────────→│
  │                                    │ processTopicSync()
  │                                    │   diff old vs new subscriptions
  │                                    │   create/update/remove TopicHandles
  │                                    │   fire onSubscribe callbacks
  │                                    │
  │←── ServerReset ───────────────────│  (session-level resync)
  │←── ServerKeyRegistration ×N ──────│  (topic payload keys: t.0.price)
  │←── ServerSync ────────────────────│
  │←── ServerValue ×N ────────────────│
  │←── SERVER_FLUSH_END ──────────────│
```

### Reconnection

```
Client                              Server
  │         [connection lost]          │
  │                                    │ handleSessionDisconnect()
  │ ReconnectEngine:                   │   session.connected = false
  │   attempt 1 (1s delay)            │   start TTL timer (10min)
  │   attempt 2 (2s delay)            │
  │   attempt 3 (4s + jitter)         │
  │                                    │
  │──── IDENTIFY (same UUID) ─────────→│
  │                                    │ existing session found
  │                                    │   cancel TTL timer
  │                                    │   rebind to new WebSocket
  │                                    │   full state resync
  │         [state: READY]             │
```

## Key Classes

### FlatStateManager

Shared composition class used by PrincipalTX, Session, and TopicPayload. Handles:
- Object flattening (`{a:{b:1}}` → `a.b = 1`)
- Array shift detection (left/right)
- Value dedup (same value → no frame)
- Type change detection (triggers full resync)
- Key lifecycle (incremental registration vs resync)

### BulkQueue

Batches frames into a single WebSocket message every N ms (default 100ms).
- ServerValue dedup: same keyId in one batch → keep latest only
- Appends SERVER_FLUSH_END at the end of each batch
- Client's `onUpdate` fires once per batch, not per frame

### TopicHandle (Server)

Per-session, per-topic state container.
- `payload` (TopicPayload → FlatStateManager) — scoped key-value store
- `setCallback(fn)` — runs immediately + on events
- `setDelayedTask(ms)` — periodic polling
- Auto-disposed on unsubscribe or disconnect

### TopicClientHandle (Client)

Client-side topic data accessor.
- `get(key)` — reads from scoped wire keys (`t.<idx>.<key>`)
- `onReceive` / `onUpdate` — per-topic callbacks
- `_dirty` + `_flushUpdate()` — batch-level onUpdate (fires on SERVER_FLUSH_END)

## Wire Key Format

```
Flat keys:         <userKey>              e.g. "price.btc"
Topic keys:        t.<index>.<userKey>    e.g. "t.0.items.length"
Array length:      <prefix>.length        e.g. "scores.length"
Array elements:    <prefix>.<n>           e.g. "scores.0", "scores.1"
```

## Size Limits

```
maxMessageSize (default 1MB)
  ├─ WebSocket layer: ws maxPayload / Netty maxFrameSize
  └─ StreamParser: maxBufferSize (FRAME_TOO_LARGE error)

maxValueSize (default 64KB)
  └─ FlatStateManager._setLeaf(): checked after serialize()
     → DanWSError("VALUE_TOO_LARGE")
```
