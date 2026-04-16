# dan-websocket

> Objects in, objects out, binary in between — only changed fields travel the wire.

[![npm](https://img.shields.io/npm/v/dan-websocket?label=npm)](https://www.npmjs.com/package/dan-websocket)
[![npm downloads](https://img.shields.io/npm/dm/dan-websocket)](https://www.npmjs.com/package/dan-websocket)
[![GitHub Packages](https://img.shields.io/github/v/release/justdancecloud/danws_typescript?label=GitHub%20Packages&color=blue)](https://github.com/justdancecloud/danws_typescript/packages)
[![Maven Central](https://img.shields.io/maven-central/v/io.github.justdancecloud/dan-websocket?label=Maven%20Central%20(Java))](https://central.sonatype.com/artifact/io.github.justdancecloud/dan-websocket)
[![CI](https://github.com/justdancecloud/danws_typescript/actions/workflows/ci.yml/badge.svg)](https://github.com/justdancecloud/danws_typescript/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/node/v/dan-websocket)](https://www.npmjs.com/package/dan-websocket)

```
npm install dan-websocket
```

Available in **8 languages**: [Java](https://github.com/justdancecloud/danws_java) · [TypeScript](https://github.com/justdancecloud/danws_typescript) · [C#](https://github.com/justdancecloud/danws_csharp) · [Dart](https://github.com/justdancecloud/danws_dart) · [Python](https://github.com/justdancecloud/danws_python) · [Go](https://github.com/justdancecloud/danws_go) · [Swift](https://github.com/justdancecloud/danws_swift) · [C++](https://github.com/justdancecloud/danws_cpp)

---

## Why WebSocket?

TCP, UDP, HTTP polling, SSE, gRPC streaming — real-time 통신 선택지는 많습니다. 그 중에서 **WebSocket을 써야 하는 이유**:

| | WebSocket | HTTP Polling | SSE | Raw TCP/UDP | gRPC Stream |
|---|---|---|---|---|---|
| Bidirectional | ✅ | ❌ | ❌ (server→client) | ✅ | ✅ |
| Browser support | ✅ native | ✅ | ✅ | ❌ | ❌ (grpc-web) |
| CDN compatible | ✅ Cloudflare, AWS ALB | ✅ | ✅ | ❌ blocked | △ |
| DDoS protection | ✅ **CF/AWS WAF works** | ✅ | ✅ | ❌ build yourself | △ |
| Mobile/Unity | ✅ all platforms | ✅ | △ | ✅ | △ |
| Latency | **~1ms** (persistent) | 100ms+ (per request) | ~1ms | ~1ms | ~1ms |
| Firewall friendly | ✅ **port 443, HTTPS upgrade** | ✅ | ✅ | ❌ custom ports | △ |

WebSocket is the only protocol that is **bidirectional + low-latency + CDN-compatible + works in every browser**. It's the de facto transport layer for games, dashboards, and collaboration tools.

---

## Why dan-websocket?

Real-time apps typically re-send entire JSON objects every time a single field changes. A dashboard with 100 fields where 1 changes per tick sends several KB per update over Socket.IO. dan-websocket sends ~13 bytes.

**Three things make this possible:**

1. **Binary protocol** — no JSON overhead. A boolean update is ~13 bytes total.
2. **Field-level dedup** — unchanged values are never re-sent. Set 100 fields, change 1, only 1 goes over the wire.
3. **Array shift detection** — a 1000-item sliding window sends 3 frames instead of 1001.

You write plain objects. dan-websocket auto-flattens them into binary leaf keys, diffs against the previous state, and sends only what changed. The client reconstructs objects via Proxy so you access `data.price.btc` like a normal object. No JSON parsing. No manual diffing. No schema.

| Scenario | dan-websocket | Socket.IO / Ably |
|----------|:---:|:---:|
| 1 bool update | **~13 bytes** | ~50-70 bytes |
| 100 fields, 1 changed | **~13 bytes** | ~several KB |
| 1000-item array, shift by 1 | **3 frames** | entire array |

**Who is it for?**

- Real-time dashboards, live feeds, tickers
- Online games with per-player state
- Any app where clients need live state that changes frequently
- Teams tired of writing custom diff logic or paying for managed services

**What makes it different from Firebase / Ably / Socket.IO?**

|  | **dan-websocket** | **Socket.IO** | **Firebase RTDB** | **Ably** |
|---|---|---|---|---|
| Protocol | Binary (DanProtocol v3.5) | JSON over Engine.IO | JSON (internal) | MessagePack / JSON |
| Self-hosted | Yes | Yes | No (Google Cloud) | No (SaaS) |
| Price | Free (MIT) | Free (MIT) | Pay-per-use | $49+/mo |
| Field-level dedup | Automatic | No | Partial | No |
| Auto-flatten | Yes | No | Partial | No |
| Array shift optimization | Automatic | No | No | No |
| Type auto-detect | 16 types | JSON only | 3 types | No |
| VarNumber compression | Yes (50-75% smaller) | No | No | No |
| Multi-device sync | Principal-based | DIY | Path-level | DIY |
| Bundle size | ~8 KB | ~10 KB | ~90+ KB | ~50+ KB |
| Cross-language | **8 languages** | Many | Many | Many |

### CDN + DDoS Protection = Production Security

dan-websocket uses standard `wss://` WebSocket. This means you can put it behind **Cloudflare, AWS CloudFront, or Azure Front Door** with zero changes:

```
[Client]  →  wss://  →  [Cloudflare CDN / WAF / DDoS Shield]
                                      ↓
                           [Origin: dan-websocket Server]
```

- **Free DDoS protection** — Cloudflare Free plan absorbs L3/L4/L7 attacks. `setMaxConnections()` / `setMaxFramesPerSec()` are origin-level safeguards
- **Binary = hard to sniff** — JSON is readable in Wireshark; DanProtocol is custom binary, raising reverse-engineering cost
- **Global latency reduction** — CDN Anycast routes to nearest PoP
- **No custom infra** — one server + Cloudflare = global game service

TCP/UDP game servers (Photon, Mirror) **cannot** sit behind a CDN. They use custom ports, get blocked by firewalls, and require dedicated DDoS infrastructure. **WebSocket + CDN solves infra cost and security simultaneously.**

### 8 Languages, One Protocol

```
Server (any language)          Client (any platform)
─────────────────────          ─────────────────────
Java (Netty)             ←→    Unity (C#)
TypeScript (ws)          ←→    Flutter (Dart)
Python (websockets)      ←→    iOS (Swift)
Go (gorilla)             ←→    Unreal Engine (C++)
                         ←→    Browser (TypeScript)
                         ←→    Backend scripts (Python/Go)
```

All combinations communicate over the **same DanProtocol v3.5 wire format**. Build a Java server, connect Unity + Flutter + Web clients — no protocol translation needed.

---

## Quick Start

**Server** (15 lines):

```typescript
import { DanWebSocketServer } from "dan-websocket/server";

const server = new DanWebSocketServer({ port: 8080, mode: "broadcast" });

// set any object — automatically converted to binary leaf keys
server.set("price", { btc: 67000, eth: 3200 });

// update every second — only changed fields are sent
setInterval(() => {
  server.set("price", {
    btc: 67000 + Math.random() * 100,
    eth: 3200,  // unchanged → not sent
  });
}, 1000);
```

**Client** (10 lines):

```typescript
import { DanWebSocketClient } from "dan-websocket";

const client = new DanWebSocketClient("ws://localhost:8080");

client.onUpdate((data) => {
  console.log(data.price.btc);  // 67042.3
  console.log(data.price.eth);  // 3200
});

client.connect();
```

That's it. The server auto-flattens `{ btc: 67000, eth: 3200 }` into binary leaf keys (`price.btc`, `price.eth`). Only the changed field goes over the wire. The client reconstructs it via Proxy.

---

## Installation

```bash
npm install dan-websocket
```

**Server import:**
```typescript
import { DanWebSocketServer } from "dan-websocket/server";
```

**Client import:**
```typescript
import { DanWebSocketClient } from "dan-websocket";
```

Both ESM and CommonJS are supported. Node.js >= 18 required.

---

## Modes

dan-websocket supports 4 modes, each designed for a different data ownership pattern:

| Mode | Auth | Data scope | Use case |
|------|:---:|-----------|----------|
| `broadcast` | No | All clients see the same state | Dashboards, tickers, live feeds |
| `principal` | Yes | Per-user state, shared across all user's devices | Games, portfolios, user profiles |
| `session_topic` | No | Each client subscribes to topics | Public charts, anonymous boards |
| `session_principal_topic` | Yes | Topics + user identity | Authenticated dashboards, personalized feeds |

---

### 1. Broadcast

The simplest mode. The server holds one global state. Every connected client gets the same data. No auth required.

**Use cases:** Live dashboards, crypto tickers, server monitoring — anything where all users see the same thing.

**Server:**

```typescript
import { DanWebSocketServer } from "dan-websocket/server";

const server = new DanWebSocketServer({ port: 8080, mode: "broadcast" });

// set any object — automatically converted to binary leaf keys
server.set("market", {
  btc: { price: 67000, volume: 1200 },
  eth: { price: 3200, volume: 800 },
});

// periodic update — only changed fields are sent
setInterval(() => {
  server.set("market", {
    btc: { price: 67000 + Math.random() * 100, volume: 1200 },
    eth: { price: 3200 + Math.random() * 10, volume: 800 },
  });
  // if only btc.price changed → 1 frame. eth unchanged → 0 bytes.
}, 1000);
```

**Client:**

```typescript
import { DanWebSocketClient } from "dan-websocket";

const client = new DanWebSocketClient("ws://localhost:8080");

// onUpdate fires once per server flush batch (~100ms) — safe for rendering
client.onUpdate((state) => {
  console.log(state.market.btc.price);   // 67042.3
  console.log(state.market.eth.volume);  // 800
});

// can also listen for individual field changes
client.onReceive((key, value) => {
  // key = "market.btc.price", value = 67042.3
});

// can also access by flat key
// client.get("market.btc.price") → 67042.3

client.connect();
```

**What happens on the wire:**
1. First connect: server sends key registrations + all current values (full sync)
2. After that: only changed leaf fields as binary frames
3. Reconnect: automatic full sync again

---

### 2. Principal

Per-user state. Each user is identified by a "principal" name (e.g., username). If one user has multiple devices, all devices share the same state and stay in sync automatically.

**Use cases:** Online games (per-player state), user dashboards, portfolio trackers.

**Auth flow:**
1. Client connects and sends a token
2. Server fires `onAuthorize` with UUID and token
3. Your code validates the token (JWT, session lookup, etc.)
4. You call `server.authorize(uuid, token, principalName)` to bind the client

**Server:**

```typescript
import { DanWebSocketServer } from "dan-websocket/server";

const server = new DanWebSocketServer({
  port: 8080,
  mode: "principal",
  principalEvictionTtl: 300_000, // auto-evict data after 5 min with no connections
});

server.enableAuthorization(true);

server.onAuthorize(async (uuid, token) => {
  try {
    const user = await verifyJWT(token);
    server.authorize(uuid, token, user.username);
  } catch {
    server.reject(uuid, "Invalid token");
  }
});

// set per-user data — sent to all of alice's devices
server.principal("alice").set("profile", {
  name: "Alice",
  score: 100,
  inventory: ["sword", "shield", "potion"],
});

// when alice scores a point — only Float64 8 bytes sent
server.principal("alice").set("profile", {
  name: "Alice",
  score: 101,         // only this is sent
  inventory: ["sword", "shield", "potion"],  // unchanged → not sent
});
```

**Client:**

```typescript
import { DanWebSocketClient } from "dan-websocket";

const client = new DanWebSocketClient("ws://localhost:8080");

client.onConnect(() => {
  client.authorize("eyJhbGciOiJIUzI1NiJ9...");
});

// onReady: fires after auth success + initial data sync complete
client.onReady(() => {
  console.log("Authenticated and synced!");
});

// receives only my principal's data
client.onUpdate((state) => {
  console.log(state.profile.name);       // "Alice"
  console.log(state.profile.score);      // 101
  console.log(state.profile.inventory);  // ["sword", "shield", "potion"]
});

client.onError((err) => {
  if (err.code === "AUTH_REJECTED") {
    console.log("Login failed:", err.message);
  }
});

client.connect();
```

**Multi-device sync:** If Alice opens the app on her phone while connected on PC, both devices see the same data. Updates go to all devices instantly.

---

### 3. Session Topic

Topic-based subscriptions without auth. Each client subscribes to "topics" with optional parameters. The server provides data per-topic per-session.

**Use cases:** Public data feeds where each client picks what to watch — stock charts (different symbols), paginated boards, real-time search results.

**Topic lifecycle:**
1. Client calls `client.subscribe("topic.name", { param: value })`
2. Server's `topic.onSubscribe` fires
3. Callback runs immediately and on every `setDelayedTask` tick
4. Client calls `client.setParams(...)` → callback re-fires with `ChangedParamsEvent`
5. Client calls `client.unsubscribe(...)` → timers stop automatically

**Server:**

```typescript
import { DanWebSocketServer, EventType } from "dan-websocket/server";

const server = new DanWebSocketServer({ port: 8080, mode: "session_topic" });

server.topic.onSubscribe((session, topic) => {

  if (topic.name === "stock.chart") {
    topic.setCallback(async (event, t) => {
      // event: SubscribeEvent (first subscribe), ChangedParamsEvent (params changed), DelayedTaskEvent (periodic)
      if (event === EventType.ChangedParamsEvent) {
        t.payload.clear(); // clear previous data on param change
      }

      const symbol = t.params.symbol as string;
      const candles = await fetchCandles(symbol);
      t.payload.set("candles", candles);       // array → auto-flatten, shift detection
      t.payload.set("meta", { symbol, count: candles.length });
    });

    topic.setDelayedTask(5000); // refresh every 5 seconds
  }
});

server.topic.onUnsubscribe((session, topic) => {
  console.log(`${session.id} unsubscribed from ${topic.name}`);
  // timers are cleaned up automatically
});
```

**Client:**

```typescript
import { DanWebSocketClient } from "dan-websocket";

const client = new DanWebSocketClient("ws://localhost:8080");

client.onReady(() => {
  client.subscribe("stock.chart", { symbol: "AAPL", interval: "1m" });
});

// per-topic onUpdate — fires once per batch
client.topic("stock.chart").onUpdate((payload) => {
  console.log(payload.meta.symbol);      // "AAPL"
  console.log(payload.candles.length);   // 200
  payload.candles.forEach((c: any) => {
    console.log(c.open, c.close);
  });
});

// per-field callback (optional)
client.topic("stock.chart").onReceive((key, value) => {
  // key = "candles.0.close", value = 189.50
});

// change params → server callback re-executes
document.getElementById("symbol-select")!.onchange = (e) => {
  client.setParams("stock.chart", {
    symbol: (e.target as HTMLSelectElement).value,
    interval: "1m",
  });
};

// unsubscribe
document.getElementById("close-chart")!.onclick = () => {
  client.unsubscribe("stock.chart");
};

client.connect();
```

**Key points:**
- Each topic's data is scoped — `topic("stock.chart")` keys are isolated from other topics
- `topic.payload.set()` works exactly like `server.set()` — auto-flattens, dedup, shift detection
- `setDelayedTask(ms)` creates a polling loop. Timers are auto-cleaned on disconnect.

---

### 4. Session Principal Topic

Combines topics with auth. The session knows who the user is (`session.principal`), so the server can provide personalized data per-topic.

**Use cases:** Authenticated apps where each user sees different data — personal dashboards, per-user notifications, role-based feeds.

**Server:**

```typescript
import { DanWebSocketServer, EventType } from "dan-websocket/server";

const server = new DanWebSocketServer({ port: 8080, mode: "session_principal_topic" });

server.enableAuthorization(true);
server.onAuthorize(async (uuid, token) => {
  try {
    const user = await verifyJWT(token);
    server.authorize(uuid, token, user.username);
  } catch {
    server.reject(uuid, "Invalid token");
  }
});

server.topic.onSubscribe((session, topic) => {

  if (topic.name === "my.dashboard") {
    topic.setCallback(async (event, t, s) => {
      // s.principal: authenticated user name (e.g., "alice")
      const user = s.principal!;

      if (event === EventType.ChangedParamsEvent) t.payload.clear();

      const dashboard = await db.getUserDashboard(user, t.params);
      t.payload.set("widgets", dashboard.widgets);
      t.payload.set("notifications", {
        unread: dashboard.unreadCount,
        items: dashboard.latestNotifications,
      });
    });

    topic.setDelayedTask(5000);
  }
});
```

**Client:**

```typescript
import { DanWebSocketClient } from "dan-websocket";

const client = new DanWebSocketClient("ws://localhost:8080");

client.onConnect(() => {
  client.authorize(localStorage.getItem("token")!);
});

client.onReady(() => {
  client.subscribe("my.dashboard", { view: "compact" });
});

client.topic("my.dashboard").onUpdate((payload) => {
  console.log("Unread:", payload.notifications.unread);
  payload.widgets.forEach((w: any) => renderWidget(w));
});

client.onError((err) => {
  if (err.code === "AUTH_REJECTED") {
    window.location.href = "/login";
  }
});

client.connect();
```

**Difference from `session_topic`:** The server callback receives `session` which has `session.principal` — the authenticated user name. This lets you query per-user data without the client sending user identity in topic params.

---

## Auto-Flatten

When you call `set()` with a nested object, dan-websocket automatically flattens it into binary leaf keys:

```typescript
// What you write:
server.set("user", {
  name: "Alice",
  scores: [10, 20],
});

// What goes on the wire (flat binary keys):
// user.name     → "Alice"  (String, 5 bytes)
// user.scores.0 → 10       (VarInteger, 1 byte)
// user.scores.1 → 20       (VarInteger, 1 byte)
// user.scores.length → 2   (VarInteger, 1 byte)
```

| Wire key | Value | Type | Size |
|----------|-------|------|------|
| `user.name` | "Alice" | String | 5 bytes |
| `user.scores.0` | 10 | VarInteger | 1 byte |
| `user.scores.1` | 20 | VarInteger | 1 byte |
| `user.scores.length` | 2 | VarInteger | 1 byte |

Nested objects flatten recursively up to depth 10 with circular reference detection. When an array shrinks, leftover keys are auto-cleaned. Only changed fields trigger a push.

The client reconstructs objects via Proxy:

```typescript
client.data.user.name;                               // "Alice"
client.data.user.scores[0];                           // 10
client.data.user.scores.forEach(s => console.log(s)); // 10, 20
```

---

## Array Shift Detection

The most common real-time array pattern is shift+push — a sliding window. Traditional libraries re-send every element that moved. dan-websocket detects the shift and sends 1 frame.

```
Before: [100, 101, 102, 103, 104]
After:  [101, 102, 103, 104, 105]    → 1 ARRAY_SHIFT_LEFT + 1 new value
```

```typescript
// server — just set the new array and shift is detected automatically
const prices: number[] = [];

onNewPrice((price) => {
  prices.push(price);
  if (prices.length > 200) prices.shift();
  topic.payload.set("chart", prices);
  // detected as left shift-by-1 + append → 3 frames instead of 201
});
```

| Pattern | Frames sent |
|---------|:-:|
| Shift+push (sliding window of 100) | **2** instead of ~100 |
| Prepend (right shift) | **3** instead of ~50 |
| Append 1 element | **2** (already optimal) |
| 10x repeated shift+push on 50 items | **20 total** instead of ~500 |

---

## VarNumber Encoding

Since v2.3.0, numbers are automatically compressed using variable-length encoding. This is transparent — you don't need to change any code. The auto-type detector picks the optimal encoding:

| Value | Old encoding | New encoding | Savings |
|-------|:---:|:---:|:---:|
| `0` | Float64 (8 bytes) | VarInteger (1 byte) | **87%** |
| `42` | Float64 (8 bytes) | VarInteger (1 byte) | **87%** |
| `1000` | Float64 (8 bytes) | VarInteger (2 bytes) | **75%** |
| `3.14` | Float64 (8 bytes) | VarDouble (3 bytes) | **62%** |
| `67000.50` | Float64 (8 bytes) | VarDouble (4 bytes) | **50%** |

**How it works:**
- **VarInteger** — zigzag + varint encoding for integers. Small numbers (0-63) fit in 1 byte.
- **VarDouble** — scale + varint mantissa for decimals. `3.14` becomes scale=2, mantissa=314, encoded as 3 bytes.
- **VarFloat** — same as VarDouble but with Float32 fallback (used by Java clients).

Numbers that can't be compressed (NaN, Infinity, scientific notation) automatically fall back to full-size Float64/Float32. The encoding is wire-compatible between TypeScript and Java.

---

## CQRS Architecture

dan-websocket naturally enables a **CQRS (Command Query Responsibility Segregation)** pattern:

```
                ┌──────────────┐
  REST/gRPC ──→ │  Your API    │ ──→ Database
  (commands)    │  (writes)    │
                └──────┬───────┘
                       │ state changed
                       ▼
                ┌──────────────┐        ┌──────────────┐
                │ dan-websocket│ ─────→ │   Clients    │
                │  server.set()│ binary │  (reads)     │
                └──────────────┘        └──────────────┘
```

Writes (commands) flow through your existing REST/gRPC API. Reads (queries) are delivered as real-time state via WebSocket. The server calls `set()` whenever state changes — whether triggered by an API request, a database event, or a background job — and every connected client receives the update instantly.

Your clients never poll for data. They submit actions through your API, and the results appear automatically through the WebSocket channel.

---

## Configuration

### Server Options

```typescript
const server = new DanWebSocketServer({
  port: 8080,                       // or server: httpServer (Express integration)
  path: "/ws",                       // WebSocket path (default: "/")
  mode: "broadcast",                 // "broadcast" | "principal" | "session_topic" | "session_principal_topic"
  session: { ttl: 600_000 },         // session TTL after disconnect (default: 10 min)
  principalEvictionTtl: 300_000,     // principal data auto-eviction TTL (default: 5 min, 0=disabled)
  debug: true,                       // console logging (or pass a custom logger function)
  flushIntervalMs: 100,              // batch flush interval (default: 100ms)
  maxMessageSize: 1_048_576,         // max WebSocket message size (default: 1MB)
  maxValueSize: 65_536,              // max single value size (default: 64KB)
});
```

**With Express:**

```typescript
import { createServer } from "http";
import express from "express";

const app = express();
const httpServer = createServer(app);
const ws = new DanWebSocketServer({
  server: httpServer,
  path: "/ws",
  mode: "broadcast",
});
httpServer.listen(3000);
```

### Client Options

```typescript
const client = new DanWebSocketClient("ws://localhost:8080", {
  reconnect: {
    enabled: true,            // default: true
    maxRetries: 10,           // 0 = unlimited
    baseDelay: 1000,          // initial retry delay
    maxDelay: 30000,          // max retry delay
    backoffMultiplier: 2,     // exponential backoff
    jitter: true,             // +/-50% random jitter
  }
});
```

### Configuration Reference

| Option | Default | Description |
|--------|---------|-------------|
| `maxMessageSize` | 1 MB | Max incoming WebSocket message. Rejects oversized messages. |
| `maxValueSize` | 64 KB | Max single serialized value. Throws `VALUE_TOO_LARGE` if exceeded. |
| `principalEvictionTtl` | 300,000 ms (5 min) | Time before evicting principal data after all sessions disconnect. Set `0` to disable. |
| `flushIntervalMs` | 100 ms | Batch flush interval. Lower = more responsive, higher = fewer messages. |
| `debug` | `false` | Set `true` for console logging, or pass a `(msg, err?) => void` function. |
| `session.ttl` | 600,000 ms (10 min) | Session TTL after disconnect. Reconnecting within TTL preserves state. |

---

## Server API Reference

### Broadcast Mode

```typescript
server.set(key, value)        // set value — auto-flatten objects/arrays, send only changes
server.get(key)               // read current value
server.keys                   // all registered key paths
server.clear(key?)            // clear one key or all keys
```

### Principal Mode

```typescript
server.principal(name)                // returns PrincipalTX instance
server.principal(name).set(key, value) // set per-user data
server.principal(name).get(key)        // read value
server.principal(name).keys            // list of keys
server.principal(name).clear(key?)     // clear one key or all keys
```

### Topic API (session_topic / session_principal_topic)

```typescript
// server — topic subscribe/unsubscribe callbacks
server.topic.onSubscribe((session, topic) => { ... });
server.topic.onUnsubscribe((session, topic) => { ... });

// TopicHandle methods
topic.setCallback(fn)            // register handler, runs immediately. fn(event, topic, session)
topic.setDelayedTask(ms)         // start periodic re-execution
topic.clearDelayedTask()         // stop periodic re-execution
topic.payload.set(key, value)    // set topic data (auto-flatten)
topic.payload.get(key)           // read value
topic.payload.clear(key?)        // clear one key or all keys
```

### Auth API (principal / session_principal_topic)

```typescript
server.enableAuthorization(true)             // enable auth
server.onAuthorize((uuid, token) => { ... }) // auth request callback
server.authorize(uuid, token, principalName) // approve auth
server.reject(uuid, reason)                  // reject auth
```

### Server Lifecycle

```typescript
server.setDebug(true)              // enable debug logging
server.close()                     // shut down server, close all connections
```

---

## Client API Reference

### Connection

```typescript
client.connect()                   // connect to server
client.disconnect()                // disconnect
client.authorize(token)            // send auth token
```

### Data Access

```typescript
client.data                        // Proxy — access as client.data.user.name
client.get(key)                    // get value by flat key: client.get("user.name")
client.keys                        // all key paths
```

### Topic Operations

```typescript
client.subscribe(topic, params?)   // subscribe to topic (params optional)
client.unsubscribe(topic)          // unsubscribe from topic
client.setParams(topic, params)    // change params → server callback re-executes
client.topic(name).data            // topic data Proxy
client.topic(name).get(key)        // get flat key within topic
```

### Events

All `on*()` methods return an unsubscribe function:

```typescript
const unsub = client.onUpdate((state) => { ... });
unsub(); // unsubscribe
```

| Event | Fires when |
|-------|-----------|
| `client.onReady(cb)` | Initial sync complete (deferred to microtask for data completeness) |
| `client.onUpdate(cb)` | Any change, once per batch (~100ms) — safe for rendering |
| `client.onReceive((key, value) => {})` | Per key change (per frame) |
| `client.topic(name).onUpdate(cb)` | Topic data changed |
| `client.topic(name).onReceive(cb)` | Per key in topic |
| `client.onConnect(cb)` | Connected |
| `client.onDisconnect(cb)` | Disconnected |
| `client.onError(cb)` | Error occurred |
| `client.onReconnecting(cb)` | Reconnect attempt |

**React cleanup example:**

```typescript
useEffect(() => {
  const unsub = client.onUpdate((state) => setData(state));
  return unsub;
}, []);
```

---

## Type Auto-Detection

dan-websocket automatically detects the type of each value and uses the most efficient encoding:

| JS Value | Wire Type | Size |
|----------|-----------|------|
| `null` | Null | 0 bytes |
| `true` / `false` | Bool | 1 byte |
| `42` (integer) | VarInteger | 1-5 bytes (variable) |
| `3.14` (decimal) | VarDouble | 2-9 bytes (variable) |
| `123n` (bigint >= 0) | Uint64 | 8 bytes |
| `-5n` (bigint < 0) | Int64 | 8 bytes |
| `"hello"` | String | variable |
| `new Uint8Array(...)` | Binary | variable |
| `new Date()` | Timestamp | 8 bytes |
| `{ ... }` / `[...]` | Auto-flatten | per-field |

Integers automatically use VarInteger (1 byte for 0-63, 2 bytes for up to 8191, etc.). Decimals use VarDouble with scale+mantissa compression.

---

## Performance

| Optimization | Effect |
|-------------|--------|
| VarNumber encoding | Integers: 1-2 bytes instead of 8. Decimals: 2-4 bytes instead of 8. |
| Binary protocol | ~13 bytes per boolean update vs ~50-70 for JSON |
| Field-level dedup | Unchanged values never re-sent |
| Array shift detection | 1000-item sliding window: 3 frames instead of 1001 |
| Batch flush (100ms) | All changes in one WebSocket message |
| Value dedup in batch | Same key set twice → only latest sent |
| Reusable buffers | Shared DataView for numeric serialization (zero allocation) |
| Single-pass encoding | Frames encoded in one pass with cached lookups |
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

## Protocol

dan-websocket uses **DanProtocol v3.5** — a binary, DLE-framed protocol with 16 data types. See [dan-protocol.md](./dan-protocol.md) for the full specification.

**Key protocol features:**
- DLE-framed: self-synchronizing frames without length prefixes
- 4-byte KeyID: supports 4B+ unique keys
- 16 data types including VarInteger, VarDouble, VarFloat
- ServerKeyDelete + ClientKeyRequest for incremental key lifecycle
- SERVER_FLUSH_END batch boundary for render-safe updates
- Heartbeat via DLE+ENQ

---

## Cross-Language

| Language | Package | Install |
|----------|---------|---------|
| TypeScript | [`dan-websocket`](https://www.npmjs.com/package/dan-websocket) | `npm install dan-websocket` |
| Java | [`io.github.justdancecloud:dan-websocket`](https://central.sonatype.com/artifact/io.github.justdancecloud/dan-websocket) | Gradle / Maven |

Wire-compatible. A TypeScript server can serve Java clients and vice versa.

---

## License

MIT
