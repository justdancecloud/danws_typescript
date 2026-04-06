# dan-websocket

> Lightweight binary protocol for real-time state synchronization — **Server to Client**

[![npm](https://img.shields.io/npm/v/dan-websocket)](https://www.npmjs.com/package/dan-websocket)
[![Maven Central](https://img.shields.io/maven-central/v/io.github.justdancecloud/dan-websocket)](https://central.sonatype.com/artifact/io.github.justdancecloud/dan-websocket)

---

## What is this?

**dan-websocket** pushes state from your server to connected clients in real time. Instead of sending JSON over WebSocket, it uses a compact binary protocol that auto-detects types and handles reconnection, heartbeat, and recovery transparently.

You just `set(key, value)` on the server — even with **objects and arrays**. They auto-flatten into individual binary fields on the wire, so only the fields that actually changed get pushed. Clients access the data as regular JavaScript objects.

```
npm install dan-websocket
```

Also available in **Java**: [dan-websocket for Java](https://github.com/justdancecloud/danws_java)

---

## The Pitch

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

Under the hood, each field is a separate binary key on the wire. When `processes[0].cpu` changes from 12.3 to 15.0, only that 8-byte Float64 gets sent — not the entire object.

---

## Why not just JSON over WebSocket?

| | JSON WebSocket | dan-websocket |
|---|---|---|
| A boolean update | `{"key":"alive","value":true}` = 30+ bytes | 11 bytes |
| Object update | Entire JSON re-sent | Only changed fields |
| Type safety | Parse then cast | Auto-typed on the wire |
| Reconnection | DIY | Built-in with exponential backoff |
| Multi-device sync | DIY per-connection | Principal-based (1 state → N sessions) |
| Heartbeat / dead detection | DIY | Built-in (10s send, 15s timeout) |

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

// Alice on PC and mobile → both update instantly
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
        items: data.items,       // array of objects → auto-flattened
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

// Page change → callback re-fires
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

## Callback Unsubscribe

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

## API Reference

### Server — Broadcast Mode

| Method | Description |
|--------|-------------|
| `server.set(key, value)` | Set value (object/array auto-flattens), sync to all |
| `server.get(key)` | Read current value |
| `server.keys` | All registered key paths |
| `server.clear(key)` | Remove key (or all flattened children) |
| `server.clear()` | Remove all keys |

### Server — Principal Mode

| Method | Description |
|--------|-------------|
| `server.principal(name).set(key, value)` | Set for principal (auto-flattens) |
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
| `topic.payload.set(key, value)` | Set data (auto-flattens objects/arrays) |
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
| `client.topic(name).data` | Proxy for topic data: `topic.data.items[0].title` |
| `client.topic(name).get(key)` | Get flat key in topic |

**Events (all return unsubscribe function):**

| Event | Callback |
|-------|----------|
| `client.onReady(cb)` | Initial sync complete |
| `client.onReceive((key, value) => {})` | Per key change |
| `client.onUpdate((state) => {})` | Any change, Proxy state view |
| `client.topic(name).onReceive((key, value) => {})` | Per key in topic |
| `client.topic(name).onUpdate((payload) => {})` | Any change in topic, Proxy view |
| `client.onConnect(cb)` / `onDisconnect(cb)` / `onError(cb)` | Connection events |

---

## Best Practices

**Use objects freely** — they auto-flatten into individual binary fields. Only changed fields get pushed.

```typescript
// Good — just set the object
server.set("dashboard", { cpu: 72.5, memory: { used: 8.2, total: 16 } });

// Changes to cpu only push 8 bytes, not the whole object
server.set("dashboard", { cpu: 73.1, memory: { used: 8.2, total: 16 } });
```

**JSON.stringify** is only needed for truly variable-schema data (user-generated config, arbitrary metadata). For structured data with known fields, use objects directly.

**Large datasets** — for 1000+ row tables, use REST for the bulk load and dan-websocket for change signals:

```typescript
topic.payload.set("lastUpdate", new Date());  // signal
// Client fetches full data via REST on signal change
```

---

## Auto-Detected Types

| JS Value | Wire Type | Size |
|----------|-----------|------|
| `null` | Null | 0 bytes |
| `true` / `false` | Bool | 1 byte |
| `42`, `3.14` | Float64 | 8 bytes |
| `123n` (bigint >= 0) | Uint64 | 8 bytes |
| `"hello"` | String | variable |
| `new Uint8Array([...])` | Binary | variable |
| `new Date()` | Timestamp | 8 bytes |
| `{ ... }` / `[...]` | Auto-flatten | per-field |

---

## Cross-Language Support

| Language | Package | Install |
|----------|---------|---------|
| **TypeScript** | [`dan-websocket`](https://www.npmjs.com/package/dan-websocket) | `npm install dan-websocket` |
| **Java** | [`io.github.justdancecloud:dan-websocket`](https://central.sonatype.com/artifact/io.github.justdancecloud/dan-websocket) | Gradle / Maven |

Wire-compatible. A TypeScript server can serve Java clients and vice versa.

---

## License

MIT
