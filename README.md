# dan-websocket

> Objects in, objects out, binary in between — only changed fields travel the wire.

[![npm](https://img.shields.io/npm/v/dan-websocket)](https://www.npmjs.com/package/dan-websocket)
[![Maven Central](https://img.shields.io/maven-central/v/io.github.justdancecloud/dan-websocket)](https://central.sonatype.com/artifact/io.github.justdancecloud/dan-websocket)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Tests](https://img.shields.io/badge/tests-265%20passing-brightgreen)]()

```
npm install dan-websocket
```

Also available in **Java**: [dan-websocket for Java](https://github.com/justdancecloud/danws_java)

---

## Quick Start

**Server** — set a plain object:

```typescript
import { DanWebSocketServer } from "dan-websocket/server";

const server = new DanWebSocketServer({ port: 8080, mode: "broadcast" });
server.set("price", { btc: 67000, eth: 3200 });
```

**Client** — read it back as a plain object:

```typescript
import { DanWebSocketClient } from "dan-websocket";

const client = new DanWebSocketClient("ws://localhost:8080");
client.onUpdate((data) => {
  console.log(data.price.btc);  // 67000
  console.log(data.price.eth);  // 3200
});
client.connect();
```

Now update one field:

```typescript
server.set("price", { btc: 67100, eth: 3200 });
// btc changed → 8 bytes sent. eth identical → not sent.
```

That's the core idea. The server auto-flattens your object into binary leaf keys (`price.btc`, `price.eth`). Only the changed field goes over the wire as an 8-byte Float64. The client reconstructs it via Proxy so you access `data.price.btc` like a normal object. No JSON parsing. No manual diffing. No schema.

---

## Why Not Just Use Socket.IO?

Socket.IO works. But every time a field changes, it re-sends the entire JSON object. For a dashboard with 100 fields where 1 changes per tick, that's ~several KB per update. dan-websocket sends ~13 bytes.

| Scenario | dan-websocket | Socket.IO / Ably |
|----------|:---:|:---:|
| 1 bool update | **~13 bytes** | ~50-70 bytes |
| 100 fields, 1 changed | **~13 bytes** | ~several KB |
| 1000-item array, shift by 1 | **3 frames** | entire array |

The difference comes from three things that work together: binary encoding (no JSON overhead), field-level dedup (unchanged values are never sent), and array shift detection (sliding windows send 1 shift frame instead of N value frames).

---

## Modes

dan-websocket supports four modes depending on your use case.

| Mode | Data scope | Use case |
|------|-----------|----------|
| `broadcast` | All clients share one state | Dashboards, live feeds, tickers |
| `principal` | Per-user state, shared across devices | Games, portfolios, user profiles |
| `session_topic` | Per-session, topic-based | Public charts, anonymous boards |
| `session_principal_topic` | Per-session topics + user identity | Authenticated dashboards, personalized feeds |

### Broadcast — all clients get the same data

```typescript
// Server
const server = new DanWebSocketServer({ port: 8080, mode: "broadcast" });

server.set("server", {
  status: "online",
  load: { cpu: 72.5, memory: 8.2 },
  uptime: 3600,
});

setInterval(() => {
  server.set("server", {
    status: "online",
    load: { cpu: Math.random() * 100, memory: 8.2 },
    uptime: process.uptime(),
  });
}, 1000);
```

```typescript
// Client
const client = new DanWebSocketClient("ws://localhost:8080");

client.onUpdate((state) => {
  console.log(state.server.load.cpu);
  console.log(state.server.status);
});

client.connect();
```

### Principal — per-user data across devices

```typescript
const server = new DanWebSocketServer({ port: 8080, mode: "principal" });

server.enableAuthorization(true);
server.onAuthorize(async (uuid, token) => {
  const user = await verifyJWT(token);
  server.authorize(uuid, token, user.name);
});

server.principal("alice").set("profile", {
  name: "Alice",
  score: 100,
  inventory: ["sword", "shield"],
});

// Later: only score changed → only 8 bytes pushed to all of Alice's devices
server.principal("alice").set("profile", {
  name: "Alice",
  score: 200,
  inventory: ["sword", "shield"],
});
```

### Session Topic — per-session data with subscriptions

```typescript
// Server
import { DanWebSocketServer, EventType } from "dan-websocket/server";

const server = new DanWebSocketServer({ port: 8080, mode: "session_topic" });

server.topic.onSubscribe((session, topic) => {
  if (topic.name === "board.posts") {
    topic.setCallback(async (event, t) => {
      if (event === EventType.ChangedParamsEvent) t.payload.clear();
      const data = await db.getPosts(t.params);
      t.payload.set("result", {
        items: data.items,
        totalCount: data.total,
      });
    });
    topic.setDelayedTask(3000); // poll every 3s
  }
});
```

```typescript
// Client
const client = new DanWebSocketClient("ws://localhost:8080");

client.onReady(() => {
  client.subscribe("board.posts", { page: 1, size: 20 });
});

client.topic("board.posts").onUpdate((payload) => {
  payload.result.items.forEach(item => console.log(item.title));
});

// Change page → callback re-fires with new data
document.getElementById("next")!.onclick = () => {
  client.setParams("board.posts", { page: 2, size: 20 });
};

client.connect();
```

### Session Principal Topic — topics with auth

```typescript
const server = new DanWebSocketServer({ port: 8080, mode: "session_principal_topic" });

server.enableAuthorization(true);
server.onAuthorize(async (uuid, token) => {
  const user = await verifyJWT(token);
  server.authorize(uuid, token, user.name);
});

server.topic.onSubscribe((session, topic) => {
  if (topic.name === "my.dashboard") {
    topic.setCallback(async (event, t, s) => {
      const data = await db.getUserDashboard(s.principal, t.params);
      t.payload.set("dashboard", {
        widgets: data.widgets,
        notifications: data.unreadCount,
      });
    });
    topic.setDelayedTask(5000);
  }
});
```

---

## How It Works

### Auto-Flatten

When you call `set("user", { name: "Alice", scores: [10, 20] })`, it auto-flattens into binary leaf keys:

| Wire key | Value | Type | Size |
|----------|-------|------|------|
| `user.name` | "Alice" | String | 5 bytes |
| `user.scores.0` | 10 | Float64 | 8 bytes |
| `user.scores.1` | 20 | Float64 | 8 bytes |
| `user.scores.length` | 2 | Float64 | 8 bytes |

Nested objects flatten recursively up to depth 10 with circular reference detection. When an array shrinks, leftover keys are auto-cleaned. Only changed fields trigger a push.

The client reconstructs objects via Proxy:

```typescript
client.data.user.name;                           // "Alice"
client.data.user.scores[0];                      // 10
client.data.user.scores.forEach(s => console.log(s));  // 10, 20
```

### Array Shift Detection

The most common real-time array pattern is shift+push — a sliding window. Traditional libraries re-send every element that moved. dan-websocket detects the shift and sends 1 frame.

```
Before: [100, 101, 102, 103, 104]
After:  [101, 102, 103, 104, 105]    → 1 ARRAY_SHIFT_LEFT + 1 new value
```

```typescript
// Server — just set the new array, detection is automatic
const prices: number[] = [];

onNewPrice((price) => {
  prices.push(price);
  if (prices.length > 200) prices.shift();
  topic.payload.set("chart", prices);
  // Detected as left-shift-by-1 + append → 3 frames instead of 201
});
```

| Pattern | Frames sent |
|---------|:-:|
| Shift+push (sliding window of 100) | **2** instead of ~100 |
| Prepend (right shift) | **3** instead of ~50 |
| Append 1 element | **2** (already optimal) |
| 10x repeated shift+push on 50 items | **20 total** instead of ~500 |

### Batch Flush

All changes within a 100ms window are batched into a single WebSocket message. If the same key is set twice in one batch, only the latest value is sent. `onUpdate` fires once per batch — safe for rendering, no render storms.

---

## Configuration

### Server Options

```typescript
const server = new DanWebSocketServer({
  port: 8080,               // or use `server: httpServer` for Express
  path: "/ws",               // WebSocket path (default: "/")
  mode: "broadcast",         // "broadcast" | "principal" | "session_topic" | "session_principal_topic"
  session: { ttl: 600_000 }, // Session TTL after disconnect (default: 10 min)
  debug: true,               // Log errors to console (or pass a logger function)
  flushIntervalMs: 100,      // Batch flush interval (default: 100ms)
  maxMessageSize: 1_048_576, // Max WebSocket message size in bytes (default: 1MB)
  maxValueSize: 65_536,      // Max single value size in bytes (default: 64KB)
});
```

**With Express:**

```typescript
import { createServer } from "http";
import express from "express";

const app = express();
const httpServer = createServer(app);
const ws = new DanWebSocketServer({ server: httpServer, path: "/ws", mode: "broadcast" });
httpServer.listen(3000);
```

### Client Options

```typescript
const client = new DanWebSocketClient("ws://localhost:8080", {
  reconnect: {
    enabled: true,           // default: true
    maxRetries: 10,          // 0 = unlimited
    baseDelay: 1000,         // initial retry delay
    maxDelay: 30000,         // max retry delay
    backoffMultiplier: 2,    // exponential backoff
    jitter: true,            // randomize +/-50%
  }
});
```

---

## API Reference

### Server — Broadcast

| Method | Description |
|--------|-------------|
| `server.set(key, value)` | Set value, auto-flattens objects/arrays, syncs to all clients |
| `server.get(key)` | Read current value |
| `server.keys` | All registered key paths |
| `server.clear(key?)` | Remove one key or all |

### Server — Principal

| Method | Description |
|--------|-------------|
| `server.principal(name).set(key, value)` | Set per-user data |
| `server.principal(name).get(key)` | Read value |
| `server.principal(name).keys` | List keys |
| `server.principal(name).clear(key?)` | Remove one or all |

### Server — Topics

| Method | Description |
|--------|-------------|
| `server.topic.onSubscribe(cb)` | `(session, topic) => void` — client subscribed |
| `server.topic.onUnsubscribe(cb)` | `(session, topic) => void` — client unsubscribed |
| `topic.setCallback(fn)` | Register handler, runs immediately. `fn(event, topic, session)` |
| `topic.setDelayedTask(ms)` | Start periodic re-invocation |
| `topic.clearDelayedTask()` | Stop periodic re-invocation |
| `topic.payload.set(key, value)` | Set topic data (auto-flattens) |
| `topic.payload.get(key)` | Read value |
| `topic.payload.clear(key?)` | Remove one or all |

### Client

| Method | Description |
|--------|-------------|
| `client.connect()` | Connect to server |
| `client.disconnect()` | Disconnect |
| `client.authorize(token)` | Send auth token |
| `client.get(key)` | Get value by flat key |
| `client.data` | Proxy for nested access: `client.data.user.name` |
| `client.keys` | All key paths |
| `client.subscribe(topic, params?)` | Subscribe to a topic |
| `client.unsubscribe(topic)` | Unsubscribe |
| `client.setParams(topic, params)` | Update params (triggers server callback) |
| `client.topic(name).data` | Proxy for topic data |
| `client.topic(name).get(key)` | Get flat key in topic |

### Events

All `on*()` methods return an unsubscribe function:

| Event | Fires when |
|-------|-----------|
| `client.onReady(cb)` | Initial sync complete |
| `client.onUpdate((state) => {})` | Any change, once per batch (~100ms) — use for rendering |
| `client.onReceive((key, value) => {})` | Per key change (per frame) |
| `client.topic(name).onUpdate(cb)` | Topic data changed |
| `client.topic(name).onReceive(cb)` | Per key in topic |
| `client.onConnect(cb)` | Connected |
| `client.onDisconnect(cb)` | Disconnected |
| `client.onError(cb)` | Error occurred |
| `client.onReconnecting(cb)` | Reconnect attempt |

```typescript
// React cleanup example
useEffect(() => {
  const unsub = client.onUpdate((state) => setData(state));
  return unsub;
}, []);
```

---

## Type Auto-Detection

| JS Value | Wire Type | Size |
|----------|-----------|------|
| `null` | Null | 0 bytes |
| `true` / `false` | Bool | 1 byte |
| `42`, `3.14` | Float64 | 8 bytes |
| `123n` (bigint >= 0) | Uint64 | 8 bytes |
| `-5n` (bigint < 0) | Int64 | 8 bytes |
| `"hello"` | String | variable |
| `new Uint8Array(...)` | Binary | variable |
| `new Date()` | Timestamp | 8 bytes |
| `{ ... }` / `[...]` | Auto-flatten | per-field |

---

## Performance

| Optimization | Effect |
|-------------|--------|
| Binary protocol | ~13 bytes per boolean update vs ~50-70 for JSON |
| Field-level dedup | Unchanged values never re-sent |
| Array shift detection | 1000-item sliding window: 3 frames instead of 1001 |
| Batch flush (100ms) | All changes in one WebSocket message |
| Value dedup in batch | Same key set twice → only latest sent |
| Incremental key registration | New keys: 3 frames instead of full resync |
| Key frame caching | Avoids rebuilding on every resync |
| Principal session index | O(1) session lookup |

---

## Error Codes

All errors are instances of `DanWSError` with a `code` property:

```typescript
client.onError((err) => {
  console.log(err.code);    // "AUTH_REJECTED"
  console.log(err.message); // "Token invalid"
});
```

| Code | Where | Description |
|------|-------|-------------|
| `HEARTBEAT_TIMEOUT` | Client | No heartbeat from server within 15s |
| `RECONNECT_EXHAUSTED` | Client | All reconnection attempts failed |
| `AUTH_REJECTED` | Client | Server rejected the auth token |
| `UNKNOWN_KEY_ID` | Client | Received value for unregistered key |
| `REMOTE_ERROR` | Client/Session | Error frame from remote peer |
| `NO_WEBSOCKET` | Client | No WebSocket impl found (install `ws`) |
| `INVALID_OPTIONS` | Server | Invalid constructor options |
| `INVALID_MODE` | Server/Session | API not available in current mode |
| `VALUE_TOO_LARGE` | Server | Serialized value exceeds `maxValueSize` |
| `INVALID_VALUE_TYPE` | Internal | Value type mismatch for DataType |
| `FRAME_PARSE_ERROR` | Internal | Malformed binary frame |

---

## Comparison

|  | **dan-websocket** | **Socket.IO** | **Firebase RTDB** | **Ably** |
|---|---|---|---|---|
| Protocol | Binary (DanProtocol v3.3) | JSON over Engine.IO | JSON (internal) | MessagePack / JSON |
| Self-hosted | Yes | Yes | No (Google Cloud) | No (SaaS) |
| Price | Free (MIT) | Free (MIT) | Pay-per-use | $49+/mo |
| Field-level dedup | Automatic | No | Partial | No |
| Auto-flatten | Yes | No | Partial | No |
| Array shift optimization | Automatic | No | No | No |
| Type auto-detect | 13 types | JSON only | 3 types | No |
| Multi-device sync | Principal-based | DIY | Path-level | DIY |
| Bundle size | ~8 KB | ~10 KB | ~90+ KB | ~50+ KB |
| Cross-language | TypeScript + Java | Many | Many | Many |

---

## Cross-Language

| Language | Package | Install |
|----------|---------|---------|
| TypeScript | [`dan-websocket`](https://www.npmjs.com/package/dan-websocket) | `npm install dan-websocket` |
| Java | [`io.github.justdancecloud:dan-websocket`](https://central.sonatype.com/artifact/io.github.justdancecloud/dan-websocket) | Gradle / Maven |

Wire-compatible. TypeScript server can serve Java clients and vice versa.

---

## Protocol

dan-websocket uses DanProtocol v3.3 — a binary, DLE-framed protocol. See [dan-protocol.md](./dan-protocol.md) for the full specification.

---

## License

MIT
