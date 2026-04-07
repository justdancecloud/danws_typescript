# dan-websocket

> Binary protocol for real-time state sync — **auto-flatten objects, field-level dedup, array shift optimization, self-hosted**

[![npm](https://img.shields.io/npm/v/dan-websocket)](https://www.npmjs.com/package/dan-websocket)
[![Maven Central](https://img.shields.io/maven-central/v/io.github.justdancecloud/dan-websocket)](https://central.sonatype.com/artifact/io.github.justdancecloud/dan-websocket)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Tests](https://img.shields.io/badge/tests-265%20passing-brightgreen)]()

```
npm install dan-websocket
```

Also available in **Java**: [dan-websocket for Java](https://github.com/justdancecloud/danws_java)

### Quick Start

```typescript
// Server — just set objects. That's it.
import { DanWebSocketServer } from "dan-websocket/server";
const server = new DanWebSocketServer({ port: 8080, mode: "broadcast" });

server.set("price", { btc: 67000, eth: 3200 });
// Internally: "price" is split into price.btc (Float64, 8 bytes) and price.eth (Float64, 8 bytes).
// Each client receives only these two binary frames — not a JSON blob.
```

```typescript
// Client — just read objects. No parsing, no schema, no boilerplate.
import { DanWebSocketClient } from "dan-websocket";
const client = new DanWebSocketClient("ws://localhost:8080");

client.onUpdate((data) => {
  console.log(data.price.btc);  // 67000
  console.log(data.price.eth);  // 3200
  // This callback fires once per server flush (~100ms batch),
  // not once per field. Safe for rendering — no render storms.
});

client.connect();
```

Now update just one field:

```typescript
server.set("price", { btc: 67100, eth: 3200 });
// Only price.btc changed → only 1 frame (8 bytes) goes over the wire.
// price.eth is identical → not sent. Zero waste.
```

**What just happened?**
- Server: you wrote a plain JavaScript object.
- Wire: only the changed leaf field (`btc`) traveled as a binary-encoded 8-byte Float64.
- Client: you read it back as a plain JavaScript object via `data.price.btc`.
- No JSON serialization. No manual diffing. No field-by-field subscriptions.

This is the core idea: **objects in, objects out, binary in between**. Only changed fields are sent — up to **99% less traffic** than re-sending full JSON. Drop in the library, cut your network costs.

---

## Why dan-websocket?

Most real-time libraries send entire JSON objects when a single field changes. dan-websocket auto-flattens objects into binary leaf keys and only sends what changed — down to a single 8-byte float.

```typescript
// Server — just put objects in
server.set("dashboard", {
  cpu: 72.5,
  memory: { used: 8.2, total: 16 },
  processes: [
    { pid: 1234, name: "node", cpu: 12.3 },
    { pid: 5678, name: "nginx", cpu: 3.1 },
  ]
});

// Client — just use objects out
client.onUpdate((state) => {
  state.dashboard.cpu;                  // 72.5
  state.dashboard.memory.used;          // 8.2
  state.dashboard.processes[0].name;    // "node"
  state.dashboard.processes.forEach(p => console.log(p.name));
});
```

When `processes[0].cpu` changes from 12.3 to 15.0, only that **8-byte Float64** goes over the wire. Not the entire object.

When a chart array shifts by 1 (`[a,b,c,d] -> [b,c,d,e]`), dan-websocket sends **1 shift frame + 1 new element** instead of re-sending every element. This is the **ARRAY_SHIFT protocol** — new in v2.0.

---

## Comparison

|  | **dan-websocket** | **Socket.IO** | **Firebase RTDB** | **Ably** |
|---|---|---|---|---|
| Protocol | Binary (DanProtocol v3.3) | JSON text, Engine.IO + Socket.IO double-wrapped | JSON (internal protocol) | MessagePack / JSON |
| **bool update** | **~13 bytes** | ~50-70 bytes | ~80-120 bytes | ~60-90 bytes |
| **100 fields, 1 changed** | **~13 bytes** | **~several KB** (entire object re-sent) | ~100-200 bytes (changed path + subtree) | **~several KB** (entire message re-sent) |
| **Array shift (1000 items)** | **1 shift frame + new items** | **entire array re-sent** | **entire subtree** | **entire array re-sent** |
| Field-level dedup | Yes, automatic. Same key within 100ms batch = last value only | No | Partial (path-level, includes subtree) | No |
| Auto-flatten | Yes. `set("user", { name, scores: [...] })` auto-expands | No. `JSON.stringify` whole object | Partial. Tree structure but no types | No. Developer serializes |
| Array sync | Auto shift/append/pop detection | Manual | Manual | Manual |
| Type auto-detect | 13 types: Bool, Float64, Int64, String, Date, Binary... | No. Everything is JSON string | string, number, boolean only | No. Developer responsibility |
| Self-hosted | Yes. `npm install`, your server | Yes. `npm install` | No. Google Cloud only | No. SaaS only |
| Price | **Free (MIT)** | **Free (MIT)** | Free tier, then pay-per-use | $49.99/mo+, $2.50/million msgs |
| Reconnection | Built-in. Exponential backoff + jitter + state restore | Built-in | Built-in | Built-in |
| Multi-device sync | Principal-based. 1 user = N sessions, auto-synced | DIY | Path-level listeners | Channel-based, user-level is DIY |
| Bundle size | ~8 KB (1 dep: `ws`) | ~10.4 KB gzipped | ~90+ KB (Firebase SDK) | ~50+ KB (Ably SDK) |
| Cross-language | TypeScript + Java (wire-compatible) | Many | Many SDKs | Many SDKs |

The unique combination: **binary + field-level dedup + auto-flatten + array shift protocol + self-hosted + free**. No other library has all six.

---

## Install

```bash
npm install dan-websocket
```

Works in **Node.js** (server + client) and **browsers** (client only).

---

## Quick Start

### 4 Modes

| Mode | Auth | Data Scope | Topics | Use Case |
|------|------|-----------|--------|----------|
| `broadcast` | No | Shared (all clients) | No | Dashboards, live feeds |
| `principal` | Yes | Per-principal (shared across devices) | No | Games, per-user data |
| `session_topic` | No | Per-session per-topic | Yes | Public charts, anonymous boards |
| `session_principal_topic` | Yes | Per-session per-topic + principal identity | Yes | Authenticated boards, personalized charts |

### 1. Broadcast Mode — all clients get the same data

**Server:**

```typescript
import { DanWebSocketServer } from "dan-websocket/server";

const server = new DanWebSocketServer({ port: 8080, mode: "broadcast" });

// Primitives
server.set("sensor.temp", 23.5);
server.set("sensor.active", true);

// Objects auto-flatten
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

**Client:**

```typescript
import { DanWebSocketClient } from "dan-websocket";

const client = new DanWebSocketClient("ws://localhost:8080");

// onUpdate fires once per server flush batch (~100ms) — ideal for rendering
client.onUpdate((state) => {
  // Object access via Proxy
  console.log(state.server.status);       // "online"
  console.log(state.server.load.cpu);     // 72.5
  console.log(state.sensor.temp);         // 23.5

  // Flat access still works
  console.log(state.get("server.load.cpu"));
});

client.connect();
```

### 2. Principal Mode — per-user data

**Server:**

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

// Alice on PC and mobile -> both update instantly
server.principal("alice").set("profile", {
  name: "Alice",
  score: 200,  // only this 8-byte field gets pushed
  inventory: ["sword", "shield"],
});
```

### 3. Session Topic Mode — per-session data with topics

**Server:**

```typescript
import { DanWebSocketServer, EventType } from "dan-websocket/server";

const server = new DanWebSocketServer({ port: 8080, mode: "session_topic" });

server.topic.onSubscribe((session, topic) => {

  if (topic.name === "board.posts") {
    topic.setCallback(async (event, t) => {
      if (event === EventType.ChangedParamsEvent) t.payload.clear();
      const data = await db.getPosts(t.params);
      t.payload.set("result", {
        items: data.items,       // array of objects -> auto-flattened
        totalCount: data.total,
      });
    });
    topic.setDelayedTask(3000);   // poll every 3s
  }

  if (topic.name === "chart.cpu") {
    topic.setCallback((event, t) => {
      t.payload.set("point", {
        value: os.cpuUsage(),
        timestamp: new Date(),
      });
    });
    topic.setDelayedTask(200);    // 200ms for real-time chart
  }

});
```

**Client:**

```typescript
const client = new DanWebSocketClient("ws://localhost:8080");

client.onReady(() => {
  client.subscribe("board.posts", { page: 1, size: 20 });
  client.subscribe("chart.cpu");
});

// Object access on topic data
client.topic("board.posts").onUpdate((payload) => {
  const items = payload.result.items;
  items.forEach(item => console.log(item.title));
  console.log("Total:", payload.result.totalCount);
});

client.topic("chart.cpu").onUpdate((payload) => {
  cpuChart.addPoint(payload.point.value, payload.point.timestamp);
});

// Page change -> callback re-fires
document.getElementById("next")!.onclick = () => {
  client.setParams("board.posts", { page: 2, size: 20 });
};

client.connect();
```

### 4. Session Principal Topic Mode — topics with auth

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

## Auto-Flatten: How Objects Work on the Wire

When you `set("user", { name: "Alice", scores: [10, 20] })`, it auto-flattens:

| Server call | Wire keys |
|-------------|-----------|
| `set("user", { name: "Alice", scores: [10, 20] })` | `user.name` = "Alice", `user.scores.0` = 10, `user.scores.1` = 20, `user.scores.length` = 2 |

- Arrays get an automatic `.length` key
- Nested objects flatten recursively (up to depth 10)
- When an array shrinks, leftover keys are auto-cleaned
- Only changed fields trigger a push — built-in dedup
- Primitives (`string`, `number`, `boolean`, `Date`, `Uint8Array`, `null`) pass through unchanged

The client reconstructs objects via Proxy:

```typescript
client.data.user.name;           // "Alice" (calls get("user.name") internally)
client.data.user.scores[0];     // 10
client.data.user.scores.forEach(s => console.log(s));  // 10, 20
```

---

## Array Sync Optimization (NEW in v2.0)

### The Problem

Real-time applications constantly update arrays — stock price history, chat messages, log entries, order books. The most common pattern is **shift+push**: remove the oldest element, add the newest.

```
Before: [100, 101, 102, 103, 104]    (5 price points)
After:  [101, 102, 103, 104, 105]    (shifted left by 1, appended 105)
```

With traditional libraries (Socket.IO, Firebase, Ably), this requires re-sending **every element** that moved — that is N value frames for an N-element array. For a 1000-point chart updating 5x/second, that is **5000 value frames per second**.

### The Solution: ARRAY_SHIFT Protocol

dan-websocket v2.0 introduces **automatic array diff detection**. When you call `set()` with an updated array, the server compares old vs new and detects shift patterns:

```typescript
// Server just sets the new array — detection is automatic
topic.payload.set("prices", newPriceHistory);  // shift+push detected!
```

Instead of re-sending every shifted element, the server sends:
1. **One ARRAY_SHIFT_LEFT frame** — tells the client to shift its local array
2. **Only the new tail elements** — the values that are actually new
3. **Updated length** — if the array size changed

The client performs the shift locally in O(n) memory copy, then applies only the new values.

### Frame Count Comparison (Verified by automated tests)

| Scenario | Array Size | Before v2.0 | After v2.0 | Reduction |
|----------|-----------|-------------|------------|-----------|
| Shift+push (sliding window) | 100 | ~100 frames | **2 frames** | **98%** |
| Shift by 10 + push 10 | 100 | ~100 frames | **10 frames** | **90%** |
| Prepend (right shift) | 50 | ~50 frames | **3 frames** | **94%** |
| Append 1 element | 10 | 2 frames | **2 frames** | Same (already optimal) |
| Pop (shrink from end) | 10→7 | full resync | **1 frame** | **99%+** |
| Unchanged (same data) | 100 | ~100 frames | **0 frames** | **100%** |
| 10× repeated shift+push | 50 | ~500 total | **20 total** (2 each) | **96%** |

> These numbers are from actual E2E tests: server sets the array, client counts `onReceive` callbacks. See `FrameCountTest.java` (Java) and `array-sync.test.ts` (TypeScript) for full benchmarks.

### Practical Examples

**Stock chart — sliding window of 200 candles:**

```typescript
// Server
const candles: number[] = [];

onNewCandle((price) => {
  candles.push(price);
  if (candles.length > 200) candles.shift();
  topic.payload.set("chart", candles);
  // Automatically detected as left-shift-by-1 + append
  // Sends: 1 ARRAY_SHIFT_LEFT + 1 new value + length = 3 frames
  // Without: 201 frames every tick
});
```

**Historical data — prepend new entries:**

```typescript
// Server
onNewLogEntry((entry) => {
  logs.unshift(entry);   // prepend
  if (logs.length > 100) logs.pop();
  topic.payload.set("logs", logs);
  // Automatically detected as right-shift-by-1 + new head
  // Sends: 1 ARRAY_SHIFT_RIGHT + 1 new value + length = 3 frames
});
```

**Order book — top 50 bids shift as market moves:**

```typescript
// Server
onOrderBookUpdate((bids) => {
  topic.payload.set("bids", bids.slice(0, 50));
  // If the order book shifted (e.g., top bid filled),
  // auto-detected as left-shift + new tail entries
});
```

### Smart Detection Algorithm

The detection algorithm works for **any shift amount** — not limited to small shifts. It:

1. Compares old and new arrays element-by-element
2. Detects left-shift patterns: `old[k:]` matches `new[0:len]`
3. Detects right-shift patterns: `old[0:len]` matches `new[k:k+len]`
4. Falls through to normal flatten if no shift detected (field-level dedup still applies)

For arrays of objects, each object element is auto-flattened. The shift frame moves the flattened keys, and only truly new/changed leaf values are sent.

### Supported Patterns

| Pattern | Detection | Protocol Frame |
|---------|-----------|---------------|
| `shift() + push()` | Left shift | `ARRAY_SHIFT_LEFT` (0x20) |
| `unshift()` (prepend) | Right shift | `ARRAY_SHIFT_RIGHT` (0x21) |
| `splice(0, k)` + append | Left shift by k | `ARRAY_SHIFT_LEFT` (0x20) |
| `push()` only | No shift needed | Normal value frames |
| `pop()` only | Length decrease | Length update only |
| Random mutation | No shift | Field-level dedup (only changed elements sent) |

---

## Topic API

Topics provide per-session scoped data with a callback-driven update model.

### setCallback + setDelayedTask Pattern

```typescript
server.topic.onSubscribe((session, topic) => {
  if (topic.name === "stock.chart") {
    // setCallback runs immediately, then on every event
    topic.setCallback(async (event, t) => {
      if (event === EventType.ChangedParamsEvent) {
        t.payload.clear();  // params changed, reset
      }
      const data = await fetchStockData(t.params.symbol);
      t.payload.set("candles", data.candles);  // array shift auto-detected!
      t.payload.set("meta", { symbol: t.params.symbol, lastUpdate: new Date() });
    });

    // Re-run callback every 200ms
    topic.setDelayedTask(200);
  }
});
```

### EventType

| Event | When |
|-------|------|
| `EventType.SubscribeEvent` | Client first subscribes |
| `EventType.ChangedParamsEvent` | Client calls `setParams()` |
| `EventType.DelayedTaskEvent` | Timer fires (from `setDelayedTask`) |

### TopicPayload

Each topic gets an isolated key-value store (`topic.payload`):

| Method | Description |
|--------|-------------|
| `payload.set(key, value)` | Set data (auto-flattens objects/arrays) |
| `payload.get(key)` | Read value |
| `payload.keys` | List all keys |
| `payload.clear(key?)` | Remove one or all |

---

## Client Proxy

Access synced state as natural JavaScript objects — no `get()` calls needed:

```typescript
// Direct object access
client.data.dashboard.cpu;              // 72.5
client.data.dashboard.memory.used;      // 8.2
client.data.users[0].name;             // "Alice"

// Array iteration works
client.data.users.forEach(u => console.log(u.name));
client.data.scores.map(s => s * 2);
client.data.items.filter(i => i.active);

// Topic data too
client.topic("chart").data.candles[0];
client.topic("board").data.items.forEach(i => console.log(i.title));

// Flat access still available
client.get("dashboard.cpu");
client.topic("chart").get("candles.0");
```

---

## Configuration

### Server Options

```typescript
const server = new DanWebSocketServer({
  port: 8080,               // Port to listen on (or use `server` option)
  server: httpServer,        // Attach to existing HTTP server (mutually exclusive with `port`)
  path: "/ws",               // WebSocket endpoint path (default: "/")
  mode: "broadcast",         // "broadcast" | "principal" | "session_topic" | "session_principal_topic"
  session: {
    ttl: 600_000,            // Session TTL in ms after disconnect (default: 10 min)
  },
  debug: true,               // Log callback errors to console (or pass a custom logger function)
  flushIntervalMs: 100,      // BulkQueue batch flush interval in ms (default: 100)
});
```

**Using with Express / HTTP server:**

```typescript
import { createServer } from "http";
import express from "express";

const app = express();
const httpServer = createServer(app);
const ws = new DanWebSocketServer({ server: httpServer, path: "/ws", mode: "broadcast" });

httpServer.listen(3000);
```

**Custom path — client must match:**

```typescript
// Server
const server = new DanWebSocketServer({ port: 8080, path: "/realtime" });

// Client
const client = new DanWebSocketClient("ws://localhost:8080/realtime");
```

### Client Options

```typescript
const client = new DanWebSocketClient("ws://localhost:8080/ws", {
  reconnect: {
    enabled: true,           // Auto-reconnect on disconnect (default: true)
    maxRetries: 10,          // 0 = unlimited retries (default: 10)
    baseDelay: 1000,         // Initial retry delay in ms (default: 1000)
    maxDelay: 30000,         // Max retry delay in ms (default: 30000)
    backoffMultiplier: 2,    // Exponential backoff factor (default: 2)
    jitter: true,            // Randomize delay +/-50% (default: true)
  }
});
```

---

## API Reference

### Server — Broadcast Mode

| Method | Description |
|--------|-------------|
| `server.set(key, value)` | Set value (object/array auto-flattens, arrays get shift detection), sync to all |
| `server.get(key)` | Read current value |
| `server.keys` | All registered key paths |
| `server.clear(key)` | Remove key (or all flattened children) |
| `server.clear()` | Remove all keys |

### Server — Principal Mode

| Method | Description |
|--------|-------------|
| `server.principal(name).set(key, value)` | Set for principal (auto-flattens, shift-detects arrays) |
| `server.principal(name).get(key)` | Read value |
| `server.principal(name).keys` | List keys |
| `server.principal(name).clear(key)` | Remove key |
| `server.principal(name).clear()` | Remove all |

### Server — Topic Modes

| Method | Description |
|--------|-------------|
| `server.topic.onSubscribe(cb)` | `(session, topic) => void` |
| `server.topic.onUnsubscribe(cb)` | `(session, topic) => void` |

**TopicHandle:**

| Method | Description |
|--------|-------------|
| `topic.name` | Topic name |
| `topic.params` | Client-provided params |
| `topic.setCallback(fn)` | Register + run immediately. `fn(event, topic, session)` |
| `topic.setDelayedTask(ms)` | Start periodic polling |
| `topic.clearDelayedTask()` | Stop polling |
| `topic.payload.set(key, value)` | Set data (auto-flattens, shift-detects arrays) |
| `topic.payload.get(key)` | Read value |
| `topic.payload.keys` | List keys |
| `topic.payload.clear(key?)` | Remove one or all |

### Client

| Method | Description |
|--------|-------------|
| `client.connect()` | Connect |
| `client.disconnect()` | Disconnect |
| `client.authorize(token)` | Send auth token |
| `client.get(key)` | Get flat key value |
| `client.data` | Proxy object for nested access: `client.data.user.name` |
| `client.keys` | All key paths |
| `client.subscribe(topic, params?)` | Subscribe to a topic |
| `client.setParams(topic, params)` | Update topic params (triggers callback) |
| `client.topic(name).data` | Proxy for topic data: `topic.data.items[0].title` |
| `client.topic(name).get(key)` | Get flat key in topic |

**Events (all return unsubscribe function):**

| Event | Callback |
|-------|----------|
| `client.onReady(cb)` | Initial sync complete |
| `client.onReceive((key, value) => {})` | Per key change (per frame) |
| `client.onUpdate((state) => {})` | Per flush batch — use for rendering (fires once per ~100ms batch) |
| `client.topic(name).onReceive((key, value) => {})` | Per key in topic |
| `client.topic(name).onUpdate((payload) => {})` | Any change in topic, Proxy view |
| `client.onConnect(cb)` / `onDisconnect(cb)` / `onError(cb)` | Connection events |

### Callback Unsubscribe

All `on*()` methods return an unsubscribe function — essential for SPA frameworks:

```typescript
// React example
useEffect(() => {
  const unsub = client.onReceive((key, value) => {
    setState(prev => ({ ...prev, [key]: value }));
  });
  return unsub; // cleanup on unmount
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
| `new Uint8Array([...])` | Binary | variable |
| `new Date()` | Timestamp | 8 bytes |
| `{ ... }` / `[...]` | Auto-flatten | per-field |

Java-specific: `BigDecimal` maps to Float64, `BigInteger` to Int64 (or String if overflow), `Short` to Int32, `Byte` to Uint8.

---

## Performance

dan-websocket v2.0 includes multiple layers of optimization:

| Optimization | Benefit |
|-------------|---------|
| **Binary protocol** | ~13 bytes for a boolean update vs ~50-70 bytes for JSON |
| **Field-level dedup** | Unchanged values in objects are never re-sent |
| **Array shift detection** | Sliding window of 1000 items: 3 frames instead of 1001 |
| **BulkQueue batching** | All changes within the flush window (default 100ms) sent as one message |
| **Value dedup in batch** | Same key set twice in one batch = only latest value sent |
| **Key frame caching** | PrincipalTX avoids rebuilding key frames on every resync |
| **Wire path caching** | TopicPayload avoids string allocation on every buildKeyFrames |
| **Principal session index** | O(1) session lookup instead of O(N) scan |
| **Incremental key registration** | New keys registered incrementally (3 frames) instead of full state resync |
| **Configurable flush interval** | Tune `flushIntervalMs` for latency vs throughput tradeoff |

---

## Cross-Language Support

| Language | Package | Install |
|----------|---------|---------|
| **TypeScript** | [`dan-websocket`](https://www.npmjs.com/package/dan-websocket) | `npm install dan-websocket` |
| **Java** | [`io.github.justdancecloud:dan-websocket`](https://central.sonatype.com/artifact/io.github.justdancecloud/dan-websocket) | Gradle / Maven |

Wire-compatible. A TypeScript server can serve Java clients and vice versa. Both implement DanProtocol v3.3, including ARRAY_SHIFT frames.

---

## Protocol

dan-websocket uses **DanProtocol v3.3** — a binary, DLE-framed protocol designed for minimal bandwidth and self-synchronizing streams.

Key protocol features:
- **DLE-based framing** — no length prefixes, robust on unreliable streams
- **4-byte KeyID** — supports 4B+ unique keys
- **13 auto-detected data types** — no schema needed
- **ARRAY_SHIFT_LEFT (0x20)** and **ARRAY_SHIFT_RIGHT (0x21)** — array shift optimization frames
- Heartbeat with 10s interval, 15s timeout

See [dan-protocol.md](./dan-protocol.md) for the full specification.

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
| `NO_WEBSOCKET` | Client | No WebSocket implementation found (install `ws` for Node.js) |
| `INVALID_OPTIONS` | Server | Invalid constructor options (e.g., both `port` and `server`) |
| `INVALID_MODE` | Server/Session | API call not available in current mode |
| `INVALID_KEY_PATH` | Internal | Key path empty, invalid chars, or exceeds 200 bytes |
| `DUPLICATE_KEY_PATH` | Internal | Key path already registered |
| `IDENTIFY_INVALID` | Internal | Client IDENTIFY payload malformed |
| `INVALID_VALUE_TYPE` | Internal | Value type mismatch for declared DataType |
| `UNKNOWN_DATA_TYPE` | Internal | Unrecognized DataType byte |
| `FRAME_PARSE_ERROR` | Internal | Malformed binary frame |
| `INVALID_DLE_SEQUENCE` | Internal | Invalid DLE escape sequence in wire data |

---

## License

MIT
