# Architecture

## Overview

dan-websocket is a server-to-client state synchronization library. The server holds state and pushes changes to connected clients in real-time using a custom binary protocol (DanProtocol v3.4).

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
┌─────────────────────────────────────────────────────┐
│  API Layer                                           │
│  server.ts / client.ts / session.ts                  │
│  principal-store.ts / topic-handle.ts                │
├─────────────────────────────────────────────────────┤
│  State Layer                                         │
│  flat-state-manager.ts (flatten + diff)              │
│  array-diff.ts (shift detection)                     │
│  state-proxy.ts (Proxy reconstruction)               │
│  flatten.ts (recursive object→leaf-key expansion)    │
├─────────────────────────────────────────────────────┤
│  Connection Layer                                    │
│  bulk-queue.ts (batch + dedup)                       │
│  heartbeat-manager.ts (10s/15s)                      │
│  reconnect-engine.ts (backoff + jitter)              │
├─────────────────────────────────────────────────────┤
│  Protocol Layer                                      │
│  codec.ts (encode/decode)                            │
│  stream-parser.ts (DLE state machine)                │
│  serializer.ts (16 types incl. VarNumber)            │
│  auto-type.ts (value → DataType detection)           │
│  types.ts (Frame, DataType, FrameType)               │
└─────────────────────────────────────────────────────┘
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
    │   ├─ Type changed? → ServerKeyDelete(old) + KeyRegistration(new)
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
    ├─ ServerValue → store[keyId] = deserialize(payload)
    │   ├─ topic wire key (t.0.xxx)? → topicHandle.notify()
    │   └─ global key? → onReceive callbacks
    ├─ ArrayShiftLeft/Right → shift store values in-place
    ├─ ServerKeyDelete → registry.delete(keyId), store.delete(keyId)
    ├─ ServerFlushEnd → onUpdate callback (once per batch)
    │   └─ onReady (deferred to microtask on initial sync)
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

## VarNumber Encoding Pipeline

Numbers flow through auto-type detection and variable-length serialization:

```
JavaScript value
    │
    ▼
auto-type.ts: detectDataType()
    ├─ Number.isInteger(v) → DataType.VarInteger
    └─ decimal number     → DataType.VarDouble
    │
    ▼
serializer.ts: serialize()
    │
    ├─ VarInteger: zigzag encode → varint bytes
    │   42 → zigzag(84) → [0x54]           (1 byte, was 8)
    │   -1 → zigzag(1)  → [0x01]           (1 byte, was 8)
    │   1000 → zigzag(2000) → [0xD0, 0x0F] (2 bytes, was 8)
    │
    ├─ VarDouble: scale byte + varint mantissa
    │   3.14 → scale=2, mantissa=314 → [0x02, 0xBA, 0x02] (3 bytes, was 8)
    │   0.5  → scale=1, mantissa=5   → [0x01, 0x05]       (2 bytes, was 8)
    │   NaN/Infinity → fallback: [0x80] + 8-byte Float64   (9 bytes)
    │
    └─ VarFloat: same as VarDouble, Float32 fallback (Java interop)
        NaN/Infinity → fallback: [0x80] + 4-byte Float32   (5 bytes)
```

**Reusable buffer optimization:** Numeric serialization shares a single 8-byte `ArrayBuffer` + `DataView` (`_sharedBuf`, `_sharedView`, `_sharedBytes`), eliminating 2 of 3 allocations per numeric value. The result is `.slice()`-copied only once at the end.

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

### onReady Timing (v2.3.0+)

The `onReady` event is deferred to the next microtask after `ServerSync` is processed. This ensures that all frames in the same batch (including any trailing ServerValue frames) are processed before `onReady` fires, guaranteeing data completeness at the moment the callback runs.

```
ServerSync received
    │
    ├─ state = "synchronizing"
    ├─ schedule microtask (queueMicrotask)
    │
    ├─ ... remaining frames in batch processed ...
    │
    ▼ microtask fires
    state = "ready"
    emit onReady callbacks
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

### Principal Eviction (v2.3.0+)

When all sessions for a principal disconnect, the server schedules data eviction after `principalEvictionTtl` (default 5 minutes). If a session reconnects before the TTL expires, eviction is cancelled.

```
Last session disconnects
    │
    ▼
_schedulePrincipalEviction(principal)
    │ setTimeout(principalEvictionTtl)
    │
    ├─ Session reconnects within TTL? → cancel timer, rebind
    │
    └─ TTL expires, no sessions? → _principals.delete(principal)
        └─ PrincipalTX data freed (keyIds recycled)
```

## Key Classes

### FlatStateManager

Shared composition class used by PrincipalTX, Session, and TopicPayload. Handles:
- Object flattening (`{a:{b:1}}` → `a.b = 1`)
- Array shift detection (left/right)
- Value dedup (same value → no frame)
- Type change detection (ServerKeyDelete + new registration)
- Key lifecycle (incremental registration vs resync)
- KeyId reuse (deleted keyIds recycled for new registrations)
- maxValueSize enforcement

### BulkQueue

Batches frames into a single WebSocket message every N ms (default 100ms).
- ServerValue dedup: same keyId in one batch → keep latest only
- Appends SERVER_FLUSH_END at the end of each batch
- Client's `onUpdate` fires once per batch, not per frame

### PrincipalTX

Per-principal state container. Key features:
- Key frame caching (`_cachedKeyFrames`) — avoids rebuilding on every resync
- Incremental key registration — new keys add 3 frames, no full resync
- `_onValue` / `_onResync` / `_onIncremental` — callback-based communication with server

### PrincipalManager

Manages all principals with session counting and eviction scheduling:
- `_sessionCounts` — tracks active session count per principal
- `_removeSession()` returns `true` when count hits 0 — caller schedules eviction
- `_hasActiveSessions()` — checked before eviction fires (double-check pattern)

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

## Data Types (16 total)

```
0x00  Null          0 bytes
0x01  Bool          1 byte
0x02  Uint8         1 byte
0x03  Uint16        2 bytes
0x04  Uint32        4 bytes
0x05  Uint64        8 bytes (bigint)
0x06  Int32         4 bytes
0x07  Int64         8 bytes (bigint)
0x08  Float32       4 bytes
0x09  Float64       8 bytes
0x0a  String        variable
0x0b  Binary        variable
0x0c  Timestamp     8 bytes (Date)
0x0d  VarInteger    variable (zigzag + varint)
0x0e  VarDouble     variable (scale + varint mantissa)
0x0f  VarFloat      variable (scale + varint mantissa, Float32 fallback)
```

## Size Limits

```
maxMessageSize (default 1MB)
  ├─ WebSocket layer: ws maxPayload
  └─ StreamParser: maxBufferSize (FRAME_TOO_LARGE error)

maxValueSize (default 64KB)
  └─ FlatStateManager._setLeaf(): checked after serialize()
     → DanWSError("VALUE_TOO_LARGE")
```

## Performance Optimizations

### Reusable Buffers (v2.3.0+)

`serializer.ts` shares a single 8-byte `ArrayBuffer` for all numeric serialization:
```
const _sharedBuf = new ArrayBuffer(8);
const _sharedView = new DataView(_sharedBuf);
const _sharedBytes = new Uint8Array(_sharedBuf);
```
This eliminates 2 of 3 allocations per numeric value. The serialized bytes are `.slice()`-copied once at the end.

### Single-Pass Encoding

`codec.ts` encodes frames in a single pass with pre-computed header bytes. No intermediate buffers or multi-pass assembly.

### Cached Lookups

- PrincipalTX caches key frames (`_cachedKeyFrames`) — invalidated only on key structure changes
- Principal session index — O(1) session lookup instead of O(N) scan
- TopicPayload wire path caching — avoids string allocation per buildKeyFrames
- State Proxy prefix cache rebuilt per access (prevents stale data)
