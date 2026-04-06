# dan-websocket

> Binary protocol for real-time state sync — **auto-flatten objects, field-level dedup, self-hosted**

[![npm](https://img.shields.io/npm/v/dan-websocket)](https://www.npmjs.com/package/dan-websocket)
[![Maven Central](https://img.shields.io/maven-central/v/io.github.justdancecloud/dan-websocket)](https://central.sonatype.com/artifact/io.github.justdancecloud/dan-websocket)

```
npm install dan-websocket
```

Also available in **Java**: [dan-websocket for Java](https://github.com/justdancecloud/danws_java)

---

## Why dan-websocket?

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

---

## Comparison

|  | **dan-websocket** | **Socket.IO** | **Firebase RTDB** | **Ably** |
|---|---|---|---|---|
| Protocol | Binary (DanProtocol) | JSON text, Engine.IO + Socket.IO double-wrapped | JSON (internal protocol) | MessagePack / JSON |
| **bool update** | **~13 bytes** | ~50-70 bytes | ~80-120 bytes | ~60-90 bytes |
| **100 fields, 1 changed** | **~13 bytes** | **~several KB** (entire object re-sent) | ~100-200 bytes (changed path + subtree) | **~several KB** (entire message re-sent) |
| Field-level dedup | Yes, automatic. Same key within 100ms batch = last value only | No | Partial (path-level, includes subtree) | No |
| Auto-flatten | Yes. `set("user", { name, scores: [...] })` auto-expands | No. `JSON.stringify` whole object | Partial. Tree structure but no types | No. Developer serializes |
| Type auto-detect | 13 types: Bool, Float64, Int64, String, Date, Binary... | No. Everything is JSON string | string, number, boolean only | No. Developer responsibility |
| Self-hosted | Yes. `npm install`, your server | Yes. `npm install` | No. Google Cloud only | No. SaaS only |
| Price | **Free (MIT)** | **Free (MIT)** | Free tier, then pay-per-use | $49.99/mo+, $2.50/million msgs |
| Reconnection | Built-in. Exponential backoff + jitter + state restore | Built-in | Built-in | Built-in |
| Multi-device sync | Principal-based. 1 user = N sessions, auto-synced | DIY | Path-level listeners | Channel-based, user-level is DIY |
| Bundle size | ~8 KB (1 dep: `ws`) | ~10.4 KB gzipped | ~90+ KB (Firebase SDK) | ~50+ KB (Ably SDK) |
| Cross-language | TypeScript + Java (wire-compatible) | Many | Many SDKs | Many SDKs |

The unique combination: **binary + field-level dedup + auto-flatten + self-hosted + free**. No other library has all five.

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
