# dan-websocket

> Objects in, objects out, binary in between — only changed fields travel the wire.

[![npm](https://img.shields.io/npm/v/dan-websocket)](https://www.npmjs.com/package/dan-websocket)
[![Maven Central](https://img.shields.io/maven-central/v/io.github.justdancecloud/dan-websocket)](https://central.sonatype.com/artifact/io.github.justdancecloud/dan-websocket)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Tests](https://img.shields.io/badge/tests-301%20passing-brightgreen)]()

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

| Mode | Auth | Data scope | Use case |
|------|:---:|-----------|----------|
| `broadcast` | No | All clients see the same state | Dashboards, tickers, live feeds |
| `principal` | Yes | Per-user state, shared across all user's devices | Games, portfolios, user profiles |
| `session_topic` | No | Each client subscribes to topics, gets its own data per topic | Public charts, anonymous boards |
| `session_principal_topic` | Yes | Topics + user identity (session knows who you are) | Authenticated dashboards, personalized feeds |

---

### 1. Broadcast

The simplest mode. The server holds one global state. Every connected client gets the same data. No auth required.

**When to use:** Live dashboards, crypto tickers, server monitoring — anything where all users see the same thing.

**Server:**

```typescript
import { DanWebSocketServer } from "dan-websocket/server";

const server = new DanWebSocketServer({ port: 8080, mode: "broadcast" });

// Set any object — it auto-flattens to binary leaf keys
server.set("market", {
  btc: { price: 67000, volume: 1200 },
  eth: { price: 3200, volume: 800 },
});

// Update periodically — only changed fields go over the wire
setInterval(() => {
  server.set("market", {
    btc: { price: 67000 + Math.random() * 100, volume: 1200 },
    eth: { price: 3200 + Math.random() * 10, volume: 800 },
  });
  // If only btc.price changed → 1 frame (8 bytes). eth stays the same → 0 bytes.
}, 1000);
```

**Client:**

```typescript
import { DanWebSocketClient } from "dan-websocket";

const client = new DanWebSocketClient("ws://localhost:8080");

// onUpdate fires once per server flush batch (~100ms), not per field.
// Safe for rendering — no render storms.
client.onUpdate((state) => {
  console.log(state.market.btc.price);   // 67042.3
  console.log(state.market.eth.volume);  // 800
});

// You can also listen per-field:
client.onReceive((key, value) => {
  // key = "market.btc.price", value = 67042.3
  // Called for every individual field change
});

// Flat access works too:
// client.get("market.btc.price") → 67042.3

client.connect();
```

**What's on the wire:**
1. First connect → server sends key registrations + all current values (full sync)
2. After that → only changed leaf fields as binary frames
3. Client disconnects and reconnects → full sync again (automatic)

---

### 2. Principal

Per-user state. Each user is identified by a "principal" name (e.g., username). If one user has multiple devices (PC + mobile), all devices share the same state and stay in sync automatically.

**When to use:** Online games (per-player state), user dashboards, portfolio trackers — anything where each user has their own data.

**Auth flow:**
1. Client connects → server fires `onAuthorize` with the client's UUID and token
2. Your code validates the token (JWT, session lookup, etc.)
3. You call `server.authorize(uuid, token, principalName)` to bind the client to a principal
4. All clients with the same principal share the same state

**Server:**

```typescript
import { DanWebSocketServer } from "dan-websocket/server";

const server = new DanWebSocketServer({ port: 8080, mode: "principal" });

// Step 1: Enable auth — clients must send a token before receiving data
server.enableAuthorization(true);

// Step 2: Handle auth — validate token, then authorize or reject
server.onAuthorize(async (uuid, token) => {
  try {
    const user = await verifyJWT(token);         // your auth logic
    server.authorize(uuid, token, user.username); // bind to principal "alice"
  } catch {
    server.reject(uuid, "Invalid token");         // close connection
  }
});

// Step 3: Set data per principal — all of alice's devices get this
server.principal("alice").set("profile", {
  name: "Alice",
  score: 100,
  inventory: ["sword", "shield", "potion"],
});

// Later: alice scores a point
server.principal("alice").set("profile", {
  name: "Alice",
  score: 101,  // only this 8-byte Float64 goes to alice's PC + mobile
  inventory: ["sword", "shield", "potion"],  // unchanged → not sent
});

// Each principal is independent — bob's data is separate
server.principal("bob").set("profile", {
  name: "Bob",
  score: 50,
  inventory: ["axe"],
});
```

**Client:**

```typescript
import { DanWebSocketClient } from "dan-websocket";

const client = new DanWebSocketClient("ws://localhost:8080");

// After connecting, send auth token
client.onConnect(() => {
  client.authorize("eyJhbGciOiJIUzI1NiJ9...");  // your JWT or session token
});

// onReady fires after auth succeeds + initial data sync completes
client.onReady(() => {
  console.log("Authenticated and synced!");
});

// Receive state updates — you only see YOUR principal's data
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

**Multi-device sync:** If Alice opens the app on her phone while already connected on PC, both devices see the same data. When the server updates Alice's principal, both devices get the update instantly.

---

### 3. Session Topic

Topic-based subscriptions without auth. Each client subscribes to "topics" with optional parameters, and the server provides data per-topic per-session. Different clients can subscribe to different topics or the same topic with different params.

**When to use:** Public data feeds where each client picks what to watch — stock charts (different symbols), paginated boards, real-time search results.

**Topic lifecycle:**
1. Client calls `client.subscribe("topic.name", { param: value })`
2. Server's `topic.onSubscribe` fires → you register a callback
3. Callback runs immediately (`SubscribeEvent`) and on every `setDelayedTask` tick
4. Client calls `client.setParams(...)` → callback re-fires with `ChangedParamsEvent`
5. Client calls `client.unsubscribe(...)` → server's `topic.onUnsubscribe` fires, timers stop

**Server:**

```typescript
import { DanWebSocketServer, EventType } from "dan-websocket/server";

const server = new DanWebSocketServer({ port: 8080, mode: "session_topic" });

server.topic.onSubscribe((session, topic) => {

  // Each topic.name gets its own handler
  if (topic.name === "stock.chart") {
    topic.setCallback(async (event, t) => {
      // event tells you WHY this callback fired:
      //   SubscribeEvent     → client just subscribed (first call)
      //   ChangedParamsEvent → client changed params (e.g., different symbol)
      //   DelayedTaskEvent   → timer tick (periodic refresh)

      if (event === EventType.ChangedParamsEvent) {
        t.payload.clear();  // params changed → clear old data
      }

      // t.params contains the client's subscription parameters
      const symbol = t.params.symbol as string;   // "AAPL"
      const interval = t.params.interval as string; // "1m"

      const candles = await fetchCandles(symbol, interval);
      t.payload.set("candles", candles);      // array → auto-flattened, shift-detected
      t.payload.set("meta", {
        symbol,
        lastUpdate: new Date(),
        count: candles.length,
      });
    });

    // Re-run the callback every 5 seconds (polling)
    topic.setDelayedTask(5000);
  }

  if (topic.name === "board.posts") {
    topic.setCallback(async (event, t) => {
      if (event === EventType.ChangedParamsEvent) t.payload.clear();

      const page = (t.params.page as number) || 1;
      const size = (t.params.size as number) || 20;
      const data = await db.getPosts({ page, size });

      t.payload.set("result", {
        items: data.items,       // array of objects → each field auto-flattened
        totalCount: data.total,
        page,
      });
    });

    topic.setDelayedTask(3000);  // refresh every 3s
  }
});

// Optional: clean up when client unsubscribes
server.topic.onUnsubscribe((session, topic) => {
  console.log(`${session.id} unsubscribed from ${topic.name}`);
  // Timers are automatically stopped — no manual cleanup needed
});
```

**Client:**

```typescript
import { DanWebSocketClient } from "dan-websocket";

const client = new DanWebSocketClient("ws://localhost:8080");

client.onReady(() => {
  // Subscribe to topics with parameters
  client.subscribe("stock.chart", { symbol: "AAPL", interval: "1m" });
  client.subscribe("board.posts", { page: 1, size: 20 });
});

// Each topic has its own onUpdate — fires once per batch, with Proxy access
client.topic("stock.chart").onUpdate((payload) => {
  // payload is a Proxy — access nested data like a plain object
  console.log(payload.meta.symbol);         // "AAPL"
  console.log(payload.meta.lastUpdate);     // Date object
  console.log(payload.candles.length);      // 200

  // Array iteration works
  payload.candles.forEach((candle: any) => {
    console.log(candle.open, candle.close);
  });
});

client.topic("board.posts").onUpdate((payload) => {
  payload.result.items.forEach((post: any) => {
    console.log(post.title, post.author);
  });
  console.log(`Page ${payload.result.page} of ${Math.ceil(payload.result.totalCount / 20)}`);
});

// Per-field callback (optional — for fine-grained updates)
client.topic("stock.chart").onReceive((key, value) => {
  // key = "candles.0.close", value = 189.50
  // Called for every individual field change within this topic
});

// Change params → server callback re-fires with ChangedParamsEvent
document.getElementById("next-page")!.onclick = () => {
  client.setParams("board.posts", { page: 2, size: 20 });
};

// Switch symbol → server clears old data, fetches new
document.getElementById("symbol-select")!.onchange = (e) => {
  client.setParams("stock.chart", {
    symbol: (e.target as HTMLSelectElement).value,
    interval: "1m",
  });
};

// Unsubscribe when done
document.getElementById("close-chart")!.onclick = () => {
  client.unsubscribe("stock.chart");
};

client.connect();
```

**Key points:**
- Each topic's data is scoped — `topic("stock.chart")` keys are isolated from `topic("board.posts")`
- `topic.payload.set()` works exactly like `server.set()` — auto-flattens objects, dedup, array shift detection
- `setDelayedTask(ms)` creates a polling loop — the callback re-runs every N ms
- When client disconnects, all timers are automatically cleaned up

---

### 4. Session Principal Topic

Combines topics with auth. The session knows who the user is (`session.principal`), so the server can provide personalized data per-topic.

**When to use:** Authenticated apps where each user sees different data based on their identity — personal dashboards, per-user notifications, role-based data feeds.

**Server:**

```typescript
import { DanWebSocketServer, EventType } from "dan-websocket/server";

const server = new DanWebSocketServer({ port: 8080, mode: "session_principal_topic" });

// Auth setup — same as principal mode
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
      // s.principal is the authenticated user name (e.g., "alice")
      const user = s.principal!;

      if (event === EventType.ChangedParamsEvent) t.payload.clear();

      const dashboard = await db.getUserDashboard(user, t.params);
      t.payload.set("widgets", dashboard.widgets);
      t.payload.set("notifications", {
        unread: dashboard.unreadCount,
        items: dashboard.latestNotifications,
      });
    });

    topic.setDelayedTask(5000);  // refresh every 5s
  }

  if (topic.name === "my.orders") {
    topic.setCallback(async (event, t, s) => {
      const user = s.principal!;
      const status = t.params.status as string || "open";
      const orders = await db.getOrders(user, { status });

      t.payload.set("orders", {
        items: orders,
        count: orders.length,
      });
    });

    topic.setDelayedTask(2000);
  }
});
```

**Client:**

```typescript
import { DanWebSocketClient } from "dan-websocket";

const client = new DanWebSocketClient("ws://localhost:8080");

// Auth first, then subscribe
client.onConnect(() => {
  client.authorize(localStorage.getItem("token")!);
});

client.onReady(() => {
  // Now authenticated — subscribe to personalized topics
  client.subscribe("my.dashboard", { view: "compact" });
  client.subscribe("my.orders", { status: "open" });
});

client.topic("my.dashboard").onUpdate((payload) => {
  console.log("Unread:", payload.notifications.unread);
  payload.notifications.items.forEach((n: any) => {
    console.log(n.message, n.timestamp);
  });
  payload.widgets.forEach((w: any) => {
    renderWidget(w);
  });
});

client.topic("my.orders").onUpdate((payload) => {
  console.log(`${payload.orders.count} open orders`);
  payload.orders.items.forEach((order: any) => {
    console.log(order.symbol, order.quantity, order.price);
  });
});

// Switch to closed orders
document.getElementById("show-closed")!.onclick = () => {
  client.setParams("my.orders", { status: "closed" });
};

client.onError((err) => {
  if (err.code === "AUTH_REJECTED") {
    window.location.href = "/login";
  }
});

client.connect();
```

**Difference from `session_topic`:** The server callback receives `session` which has `session.principal` — the authenticated user name. This lets you query per-user data (orders, notifications, dashboards) without the client sending user identity in topic params.

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
