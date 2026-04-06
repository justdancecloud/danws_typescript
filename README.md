# dan-websocket

> Lightweight binary protocol for real-time state synchronization — **Server to Client**

[![npm](https://img.shields.io/npm/v/dan-websocket)](https://www.npmjs.com/package/dan-websocket)
[![Maven Central](https://img.shields.io/maven-central/v/io.github.justdancecloud/dan-websocket)](https://central.sonatype.com/artifact/io.github.justdancecloud/dan-websocket)

---

## What is this?

**dan-websocket** pushes state from your server to connected clients in real time. Instead of sending JSON over WebSocket, it uses a compact binary protocol ([DanProtocol v3.0](./dan-protocol-3.0.md)) that auto-detects types and handles reconnection, heartbeat, and recovery transparently.

You just `set(key, value)` on the server. All connected clients receive it instantly.

```
npm install dan-websocket
```

Also available in **Java**: [dan-websocket for Java](https://github.com/justdancecloud/danws_java)

---

## Why not just JSON over WebSocket?

| | JSON WebSocket | dan-websocket |
|---|---|---|
| A boolean update | `{"key":"alive","value":true}` = 30+ bytes | 9 bytes |
| Type safety | Parse then cast | Auto-typed on the wire |
| Reconnection | DIY | Built-in with exponential backoff |
| Multi-device sync | DIY per-connection | Principal-based (1 state → N sessions) |
| Heartbeat / dead detection | DIY | Built-in (10s send, 15s timeout) |

---

## Install

```bash
npm install dan-websocket
```

Works in **Node.js** (server + client) and **browsers** (client only).

---

## 4 Modes

| Mode | Auth | Data Scope | Topics | Use Case |
|------|------|-----------|--------|----------|
| `broadcast` | No | Shared (all clients) | No | Dashboards, live feeds |
| `principal` | Yes | Per-principal (shared across devices) | No | Games, per-user data |
| `session_topic` | No | Per-session per-topic | Yes | Public charts, anonymous boards |
| `session_principal_topic` | Yes | Per-session per-topic + principal identity | Yes | Authenticated boards, personalized charts |

---

## Quick Start

### 1. Broadcast Mode — all clients get the same data

Perfect for dashboards, live feeds, status pages.

**Server:**

```typescript
import { DanWebSocketServer } from "dan-websocket/server";

const server = new DanWebSocketServer({ port: 8080, mode: "broadcast" });

server.set("sensor.temp", 23.5);          // number → Float64
server.set("sensor.status", "online");    // string → String
server.set("sensor.active", true);        // boolean → Bool
server.set("sensor.updated", new Date()); // Date → Timestamp

setInterval(() => {
  server.set("sensor.temp", 20 + Math.random() * 10);
}, 1000);
```

**Client:**

```typescript
import { DanWebSocketClient } from "dan-websocket";

const client = new DanWebSocketClient("ws://localhost:8080");

client.onReady(() => {
  console.log("Temperature:", client.get("sensor.temp"));
});

client.onReceive((key, value) => {
  document.getElementById(key)!.textContent = String(value);
});

client.connect();
```

### 2. Principal Mode — per-user data via principals

A **principal** = one authenticated user. All their sessions (PC, mobile, other tabs) share the same state automatically.

**Server:**

```typescript
const server = new DanWebSocketServer({ port: 8080, mode: "principal" });

server.enableAuthorization(true);
server.onAuthorize(async (uuid, token) => {
  const user = await verifyJWT(token);
  server.authorize(uuid, token, user.name);
});

server.principal("alice").set("score", 100);
server.principal("bob").set("score", 50);

// Alice opens on PC and mobile → both see score=100
server.principal("alice").set("score", 200); // both devices update instantly
```

**Client:**

```typescript
const client = new DanWebSocketClient("ws://localhost:8080");

client.onConnect(() => client.authorize(myJWTToken));

client.onReady(() => {
  console.log("My score:", client.get("score"));
});

client.connect();
```

### 3. Session Topic Mode — real-time per-session data with topics

Each session subscribes to **topics** with parameters. The server periodically re-evaluates the data and pushes changes automatically. Only changed values are sent — the client's UI updates in real time with zero extra effort.

**Server:**

```typescript
const server = new DanWebSocketServer({ port: 8080, mode: "session_topic" });

// Re-run onTask every 1 second to detect data changes
server.topic.addDelayTaskEvent(1000);

server.topic.onTask(async (session, topic) => {
  // topic.name   — "board.posts", "chart.cpu", etc.
  // topic.params — { page: 1, size: 20, sort: "date" }

  if (topic.name === "board.posts") {
    const data = await db.getPosts(topic.params);
    topic.payload.set("items", JSON.stringify(data.items));
    topic.payload.set("totalCount", data.total);
    // ↑ Only pushes to client when value actually changed
  }

  if (topic.name === "chart.cpu") {
    topic.payload.set("value", os.cpuUsage());
    topic.payload.set("timestamp", new Date());
  }
});
```

**Client:**

```typescript
const client = new DanWebSocketClient("ws://localhost:8080");

// Subscribe to topics
client.subscribe("board.posts", { page: 1, size: 20, sort: "date" });
client.subscribe("chart.cpu");

// Read topic data
client.topic("board.posts").get("items");
client.topic("board.posts").get("totalCount");

// Listen for updates per topic
client.topic("board.posts").onReceive((key, value) => {
  if (key === "items") renderTable(JSON.parse(value));
  if (key === "totalCount") updatePagination(value);
});

client.topic("chart.cpu").onReceive((key, value) => {
  if (key === "value") chart.addPoint(value);
});

// Change params → server re-runs onTask with new params
client.setParams("board.posts", { page: 2, size: 20, sort: "date" });

// Unsubscribe → server stops polling, data auto-cleared
client.unsubscribe("chart.cpu");

client.connect();
```

**What happens under the hood:**

```
subscribe("board.posts", {page:1})
  → onTask runs immediately → payload.set() → data syncs to client
  → 1s later: onTask re-runs → DB re-query → same data? skip. changed? push.
  → 1s later: onTask re-runs → new post added? auto-push to client.
  → ...repeats until unsubscribe

setParams("board.posts", {page:2})
  → onTask runs immediately with new params → fresh data → push
  → polling continues with new params

unsubscribe("board.posts")
  → polling stops, topic data cleared on client
```

### 4. Session Principal Topic Mode — topics with authentication

Same as `session_topic`, but with principal authentication. The server knows who is requesting what.

```typescript
const server = new DanWebSocketServer({ port: 8080, mode: "session_principal_topic" });

server.enableAuthorization(true);
server.onAuthorize(async (uuid, token) => {
  const user = await verifyJWT(token);
  server.authorize(uuid, token, user.name);
});

server.topic.addDelayTaskEvent(2000);

server.topic.onTask(async (session, topic) => {
  // session.principal = "alice" — know who is asking
  if (topic.name === "my.orders") {
    const orders = await db.getOrders(session.principal, topic.params);
    topic.payload.set("items", JSON.stringify(orders.items));
    topic.payload.set("total", orders.total);
  }
});
```

---

## Real-World Examples

### Real-time CPU monitoring dashboard

```typescript
// Server
server.topic.addDelayTaskEvent(500);
server.topic.onTask(async (session, topic) => {
  topic.payload.set("cpu", os.cpuUsage());
  topic.payload.set("memory", os.memoryUsage());
  topic.payload.set("uptime", process.uptime());
});

// Client
client.subscribe("system.monitor");
client.topic("system.monitor").onReceive((key, value) => {
  gauges[key].update(value);
});
```

### Live stock chart

```typescript
// Server
server.topic.addDelayTaskEvent(200);
server.topic.onTask(async (session, topic) => {
  const price = await stockAPI.getPrice(topic.params.symbol);
  topic.payload.set("price", price);
  topic.payload.set("timestamp", new Date());
});

// Client
client.subscribe("stock", { symbol: "AAPL" });
client.topic("stock").onReceive((key, value) => {
  if (key === "price") chart.addPoint(value);
});
```

### Paginated board with live updates

```typescript
// Server
server.topic.addDelayTaskEvent(3000);
server.topic.onTask(async (session, topic) => {
  const { page, size } = topic.params;
  const result = await db.posts.find({ skip: (page-1)*size, limit: size });
  topic.payload.set("items", JSON.stringify(result.items));
  topic.payload.set("totalCount", result.total);
});

// Client — page change
document.getElementById("next")!.onclick = () => {
  currentPage++;
  client.setParams("posts", { page: currentPage, size: 20 });
};
// → Server automatically re-queries with new page, pushes fresh data
```

---

## API Reference

### Server — Broadcast Mode

```typescript
const server = new DanWebSocketServer({ port: 8080, mode: "broadcast" });
```

| Method | Description |
|--------|-------------|
| `server.set(key, value)` | Set value, auto-detect type, sync to all clients |
| `server.get(key)` | Read current value (`undefined` if not set) |
| `server.keys` | All registered key paths |
| `server.clear(key)` | Remove one key |
| `server.clear()` | Remove all keys |

### Server — Principal Mode

```typescript
const server = new DanWebSocketServer({ port: 8080, mode: "principal" });
```

| Method | Description |
|--------|-------------|
| `server.principal(name).set(key, value)` | Set for principal |
| `server.principal(name).get(key)` | Read value |
| `server.principal(name).keys` | List keys |
| `server.principal(name).clear(key)` | Remove one key |
| `server.principal(name).clear()` | Remove all keys |

### Server — Topic Modes

```typescript
const server = new DanWebSocketServer({ port: 8080, mode: "session_topic" });
// or
const server = new DanWebSocketServer({ port: 8080, mode: "session_principal_topic" });
```

| Method | Description |
|--------|-------------|
| `server.topic.addDelayTaskEvent(ms)` | Set polling interval for onTask |
| `server.topic.onTask(cb)` | Topic task callback: `(session, topic) => void` |

**`topic` object in onTask callback:**

| Property / Method | Description |
|-------------------|-------------|
| `topic.name` | Topic name (e.g. `"board.posts"`) |
| `topic.params` | Client-provided params `{ page: 1, size: 20 }` |
| `topic.payload.set(key, value)` | Set data scoped to this topic (auto-pushes on change) |
| `topic.payload.get(key)` | Read current value |
| `topic.payload.keys` | List keys in this topic's payload |
| `topic.payload.clear(key)` | Remove one key |
| `topic.payload.clear()` | Remove all keys in this topic |

### Server — Auth & Sessions

| Method | Description |
|--------|-------------|
| `server.enableAuthorization(enabled, opts?)` | Enable token auth |
| `server.authorize(uuid, token, principal)` | Accept, bind to principal |
| `server.reject(uuid, reason?)` | Reject |
| `server.onConnection(cb)` | New session connected |
| `server.onAuthorize(cb)` | Auth token received: `(uuid, token)` |
| `server.onSessionExpired(cb)` | Session TTL expired |
| `server.getSession(uuid)` | Get session by ID |
| `server.getSessionsByPrincipal(name)` | All sessions for principal |
| `server.isConnected(uuid)` | Connection status |
| `server.close()` | Shutdown |

### Client

```typescript
const client = new DanWebSocketClient(url, options?);
```

| Method | Description |
|--------|-------------|
| `client.connect()` | Connect to server |
| `client.disconnect()` | Disconnect (no auto-reconnect) |
| `client.authorize(token)` | Send auth token |
| `client.get(key)` | Current value — broadcast/principal modes |
| `client.keys` | All received key paths |
| `client.id` | This client's UUIDv7 (stable across reconnects) |
| `client.state` | Connection state string |

**Topic methods (topic modes):**

| Method | Description |
|--------|-------------|
| `client.subscribe(name, params?)` | Subscribe to a topic with optional params |
| `client.unsubscribe(name)` | Unsubscribe from a topic |
| `client.setParams(name, params)` | Update params for an existing topic |
| `client.topics` | List subscribed topic names |
| `client.topic(name).get(key)` | Get value within topic's payload |
| `client.topic(name).keys` | List keys in topic's payload |
| `client.topic(name).onReceive(cb)` | Listen for updates: `(key, value) => void` |

| Event | Callback |
|-------|----------|
| `client.onConnect(cb)` | WebSocket opened |
| `client.onReady(cb)` | Initial sync complete |
| `client.onReceive(cb)` | Value update: `(key, value)` — broadcast/principal modes |
| `client.onDisconnect(cb)` | Connection lost |
| `client.onReconnecting(cb)` | Retry attempt: `(attempt, delayMs)` |
| `client.onReconnect(cb)` | Reconnected and re-synced |
| `client.onReconnectFailed(cb)` | All retries exhausted |
| `client.onError(cb)` | Protocol error |

### Reconnection Options

```typescript
new DanWebSocketClient(url, {
  reconnect: {
    enabled: true,           // default: true
    maxRetries: 10,          // 0 = unlimited
    baseDelay: 1000,         // ms
    maxDelay: 30000,         // ms
    backoffMultiplier: 2,
    jitter: true,            // +/-50% randomization
  }
});
```

---

## Auto-Detected Types

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

---

## Cross-Language Support

dan-websocket is available in two languages with identical APIs and wire-compatible binary protocol:

| Language | Package | Install |
|----------|---------|---------|
| **TypeScript** | [`dan-websocket`](https://www.npmjs.com/package/dan-websocket) | `npm install dan-websocket` |
| **Java** | [`io.github.justdancecloud:dan-websocket`](https://central.sonatype.com/artifact/io.github.justdancecloud/dan-websocket) | Gradle / Maven |

A TypeScript server can serve Java clients and vice versa.

---

## Protocol

See [dan-protocol-3.0.md](./dan-protocol-3.0.md) for the full binary protocol specification.

---

## License

MIT
