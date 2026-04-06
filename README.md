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

## Two ways to listen for data

Every mode supports two callback styles. Use whichever fits your use case:

| Callback | Fires when | Receives | Best for |
|----------|-----------|----------|----------|
| `onReceive((key, value) => {})` | Each individual key changes | Changed key + value | Updating a specific UI element per key |
| `onUpdate((payload) => {})` | Any key changes | Full current state | Rendering a whole view from latest state |

```typescript
// onReceive — per key, granular
client.onReceive((key, value) => {
  if (key === "sensor.temp") tempGauge.update(value);
  if (key === "sensor.status") statusBadge.set(value);
});

// onUpdate — full state, all at once
client.onUpdate((payload) => {
  tempGauge.update(payload.get("sensor.temp"));
  statusBadge.set(payload.get("sensor.status"));
  // payload.keys → ["sensor.temp", "sensor.status", ...]
});
```

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

**Client — using onReceive (per key):**

```typescript
import { DanWebSocketClient } from "dan-websocket";

const client = new DanWebSocketClient("ws://localhost:8080");

client.onReceive((key, value) => {
  if (key === "sensor.temp") tempGauge.update(value);
  if (key === "sensor.status") statusLabel.textContent = value;
  if (key === "sensor.active") activeLight.classList.toggle("on", value);
});

client.connect();
```

**Client — using onUpdate (full state):**

```typescript
const client = new DanWebSocketClient("ws://localhost:8080");

client.onUpdate((payload) => {
  tempGauge.update(payload.get("sensor.temp"));
  statusLabel.textContent = payload.get("sensor.status");
  activeLight.classList.toggle("on", payload.get("sensor.active"));
  lastUpdate.textContent = payload.get("sensor.updated")?.toISOString();
  // payload.keys → all current keys
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
server.principal("alice").set("rank", 1);
server.principal("alice").set("name", "Alice");

server.principal("bob").set("score", 50);
server.principal("bob").set("rank", 2);
server.principal("bob").set("name", "Bob");

// Alice opens on PC and mobile → both see score=100
server.principal("alice").set("score", 200); // both devices update instantly
```

**Client — using onReceive:**

```typescript
const client = new DanWebSocketClient("ws://localhost:8080");

client.onConnect(() => client.authorize(myJWTToken));

client.onReceive((key, value) => {
  if (key === "score") scoreDisplay.textContent = value;
  if (key === "rank") rankBadge.textContent = `#${value}`;
  if (key === "name") nameLabel.textContent = value;
});

client.connect();
```

**Client — using onUpdate:**

```typescript
const client = new DanWebSocketClient("ws://localhost:8080");

client.onConnect(() => client.authorize(myJWTToken));

client.onUpdate((payload) => {
  scoreDisplay.textContent = payload.get("score");
  rankBadge.textContent = `#${payload.get("rank")}`;
  nameLabel.textContent = payload.get("name");
});

client.connect();
```

### 3. Session Topic Mode — real-time per-session data with topics

Each session subscribes to **topics** with parameters. The server defines a callback per topic — it runs immediately on subscribe, repeats on a polling interval, and re-fires on params change. Each topic has its own scoped payload, so data never collides.

**Server:**

```typescript
import { DanWebSocketServer, EventType } from "dan-websocket/server";

// ── Define callbacks ──

async function callbackBoardPosts(event: EventType, topic: Topic) {
  if (event === EventType.ChangedParamsEvent) {
    topic.payload.clear(); // clear old page data before loading new page
  }
  const { page, size, sort } = topic.params;
  const data = await db.getPosts({ page, size, sort });
  topic.payload.set("items", JSON.stringify(data.items));
  topic.payload.set("totalCount", data.total);
  // ↑ Only pushes to client when value actually changed
}

async function callbackCpuChart(event: EventType, topic: Topic) {
  topic.payload.set("value", os.cpuUsage());
  topic.payload.set("timestamp", new Date());
}

async function callbackStockPrice(event: EventType, topic: Topic) {
  const price = await stockAPI.getPrice(topic.params.symbol);
  topic.payload.set("price", price);
  topic.payload.set("updated", new Date());
}

// ── Set up server ──

const server = new DanWebSocketServer({ port: 8080, mode: "session_topic" });

server.topic.onSubscribe((session, topic) => {

  if (topic.name === "board.posts") {
    topic.setCallback(callbackBoardPosts);  // runs immediately
    topic.setDelayedTask(3000);             // then every 3s
  }

  if (topic.name === "chart.cpu") {
    topic.setCallback(callbackCpuChart);
    topic.setDelayedTask(200);              // 200ms for real-time chart
  }

  if (topic.name === "stock.price") {
    topic.setCallback(callbackStockPrice);
    topic.setDelayedTask(500);
  }

});
```

**Client — using onReceive (per key, per topic):**

```typescript
import { DanWebSocketClient } from "dan-websocket";

const client = new DanWebSocketClient("ws://localhost:8080");

client.onReady(() => {
  client.subscribe("board.posts", { page: 1, size: 20, sort: "date" });
  client.subscribe("chart.cpu");
  client.subscribe("stock.price", { symbol: "AAPL" });
});

client.topic("board.posts").onReceive((key, value) => {
  if (key === "items") renderTable(JSON.parse(value));
  if (key === "totalCount") updatePagination(value);
});

client.topic("chart.cpu").onReceive((key, value) => {
  if (key === "value") cpuGauge.update(value);
  if (key === "timestamp") cpuTime.textContent = value.toISOString();
});

client.topic("stock.price").onReceive((key, value) => {
  if (key === "price") priceChart.addPoint(value);
  if (key === "updated") priceTime.textContent = value.toISOString();
});

client.connect();
```

**Client — using onUpdate (full payload, per topic):**

```typescript
const client = new DanWebSocketClient("ws://localhost:8080");

client.onReady(() => {
  client.subscribe("board.posts", { page: 1, size: 20, sort: "date" });
  client.subscribe("chart.cpu");
  client.subscribe("stock.price", { symbol: "AAPL" });
});

client.topic("board.posts").onUpdate((payload) => {
  renderTable(JSON.parse(payload.get("items")));
  updatePagination(payload.get("totalCount"));
});

client.topic("chart.cpu").onUpdate((payload) => {
  cpuGauge.update(payload.get("value"));
  cpuTime.textContent = payload.get("timestamp")?.toISOString();
});

client.topic("stock.price").onUpdate((payload) => {
  priceChart.addPoint(payload.get("price"));
  priceTime.textContent = payload.get("updated")?.toISOString();
});

client.connect();
```

**Interacting with topics:**

```typescript
// Change page → callback re-fires immediately with ChangedParamsEvent, then polling resumes
document.getElementById("next-page")!.onclick = () => {
  client.setParams("board.posts", { page: 2, size: 20, sort: "date" });
};

// Switch stock symbol
document.getElementById("stock-select")!.onchange = (e) => {
  client.setParams("stock.price", { symbol: e.target.value });
};

// Stop watching CPU → polling stops, data auto-cleared
document.getElementById("close-cpu")!.onclick = () => {
  client.unsubscribe("chart.cpu");
};
```

**What happens under the hood:**

```
subscribe("board.posts", {page:1})
  → setCallback(callbackBoardPosts) → runs with SubscribeEvent → data syncs
  → setDelayedTask(3000) → polling starts
  → 3s: callback(DelayedTaskEvent) → DB re-query → same? skip. changed? push.
  → 3s: callback(DelayedTaskEvent) → new post added by another user? auto-push.
  → ...

setParams("board.posts", {page:2})
  → polling pauses
  → callback(ChangedParamsEvent) → payload.clear() + reload page 2
  → polling resumes with new params

unsubscribe("board.posts")
  → polling stops, topic payload auto-cleared on client
```

**EventType values:**

| EventType | When | Description |
|-----------|------|-------------|
| `SubscribeEvent` | `setCallback()` | Initial subscription, first data load |
| `ChangedParamsEvent` | `client.setParams()` | Client changed params, task pauses → callback → task resumes |
| `DelayedTaskEvent` | `setDelayedTask()` interval | Periodic polling tick |

### 4. Session Principal Topic Mode — topics with authentication

Same as `session_topic`, but with principal authentication. The server knows who is requesting what.

**Server:**

```typescript
import { DanWebSocketServer, EventType } from "dan-websocket/server";

async function callbackMyOrders(event: EventType, topic: Topic, session: Session) {
  if (event === EventType.ChangedParamsEvent) {
    topic.payload.clear();
  }
  const orders = await db.getOrders(session.principal, topic.params);
  topic.payload.set("items", JSON.stringify(orders.items));
  topic.payload.set("total", orders.total);
}

async function callbackNotifications(event: EventType, topic: Topic, session: Session) {
  const count = await db.getUnreadCount(session.principal);
  topic.payload.set("unread", count);
}

const server = new DanWebSocketServer({ port: 8080, mode: "session_principal_topic" });

server.enableAuthorization(true);
server.onAuthorize(async (uuid, token) => {
  const user = await verifyJWT(token);
  server.authorize(uuid, token, user.name);
});

server.topic.onSubscribe((session, topic) => {

  if (topic.name === "my.orders") {
    topic.setCallback(callbackMyOrders);
    topic.setDelayedTask(5000);
  }

  if (topic.name === "my.notifications") {
    topic.setCallback(callbackNotifications);
    topic.setDelayedTask(2000);
  }

});
```

**Client:**

```typescript
const client = new DanWebSocketClient("ws://localhost:8080");

client.onConnect(() => client.authorize(myJWTToken));

client.onReady(() => {
  client.subscribe("my.orders", { status: "pending", page: 1 });
  client.subscribe("my.notifications");
});

// onUpdate — render full order list when any order data changes
client.topic("my.orders").onUpdate((payload) => {
  renderOrders(JSON.parse(payload.get("items")));
  orderCount.textContent = payload.get("total");
});

// onReceive — just watch for unread count changes
client.topic("my.notifications").onReceive((key, value) => {
  if (key === "unread") updateBadge(value);
});

// Filter change → callback re-fires with ChangedParamsEvent
document.getElementById("filter")!.onchange = (e) => {
  client.setParams("my.orders", { status: e.target.value, page: 1 });
};

client.connect();
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
| `server.topic.onSubscribe(cb)` | Client subscribed: `(session, topic) => void` |
| `server.topic.onUnsubscribe(cb)` | Client unsubscribed: `(session, topic) => void` (optional) |

**`topic` object in callbacks:**

| Property / Method | Description |
|-------------------|-------------|
| `topic.name` | Topic name (e.g. `"board.posts"`) |
| `topic.params` | Client-provided params `{ page: 1, size: 20 }` |
| `topic.setCallback(fn)` | Register callback + run immediately. `fn(event, topic, session?)` |
| `topic.setDelayedTask(ms)` | Start periodic polling using registered callback |
| `topic.clearDelayedTask()` | Stop polling (auto-called on unsubscribe) |
| `topic.payload.set(key, value)` | Set data scoped to this topic (auto-pushes on change) |
| `topic.payload.get(key)` | Read current value |
| `topic.payload.keys` | List keys in this topic's payload |
| `topic.payload.clear(key?)` | Remove one or all keys |

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
| `client.get(key)` | Current value |
| `client.keys` | All received key paths |
| `client.id` | This client's UUIDv7 (stable across reconnects) |
| `client.state` | Connection state string |

**Data callbacks (broadcast / principal modes):**

| Callback | Description |
|----------|-------------|
| `client.onReceive((key, value) => {})` | Fires per individual key change |
| `client.onUpdate((payload) => {})` | Fires on any change with full state: `payload.get(key)`, `payload.keys` |

**Topic methods (topic modes):**

| Method | Description |
|--------|-------------|
| `client.subscribe(name, params?)` | Subscribe to a topic with optional params |
| `client.unsubscribe(name)` | Unsubscribe from a topic |
| `client.setParams(name, params)` | Update params for an existing topic |
| `client.topics` | List subscribed topic names |
| `client.topic(name).get(key)` | Get value within topic's payload |
| `client.topic(name).keys` | List keys in topic's payload |
| `client.topic(name).onReceive((key, value) => {})` | Fires per key change in this topic |
| `client.topic(name).onUpdate((payload) => {})` | Fires on any change with full topic payload |

**Connection events:**

| Event | Callback |
|-------|----------|
| `client.onConnect(cb)` | WebSocket opened |
| `client.onReady(cb)` | Initial sync complete |
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
