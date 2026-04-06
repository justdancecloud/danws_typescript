# dan-websocket

> Lightweight binary protocol for real-time state synchronization — **Server to Client**

[![npm](https://img.shields.io/npm/v/dan-websocket)](https://www.npmjs.com/package/dan-websocket)
[![Maven Central](https://img.shields.io/maven-central/v/io.github.justdancecloud/dan-websocket)](https://central.sonatype.com/artifact/io.github.justdancecloud/dan-websocket)

---

## What is this?

**dan-websocket** pushes state from your server to connected clients in real time. Instead of sending JSON over WebSocket, it uses a compact binary protocol ([DanProtocol v3.0](./dan-protocol-3.0.md)) that auto-detects types and handles reconnection, heartbeat, and recovery transparently.

You just `set(key, value)` on the server. All connected clients receive it instantly.

```
npm install dan-websocket          # TypeScript / Node.js
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
| Key registration | N/A | Server declares keys, client knows what to expect |

---

## Install

```bash
npm install dan-websocket
```

Works in **Node.js** (server + client) and **browsers** (client only).

---

## Quick Start

### 1. Broadcast Mode — all clients get the same data

Perfect for dashboards, live feeds, status pages.

**Server:**

```typescript
import { DanWebSocketServer } from "dan-websocket/server";

const server = new DanWebSocketServer({ port: 8080, mode: "broadcast" });

// Just set values. Types are auto-detected. No schema needed.
server.set("sensor.temp", 23.5);          // number → Float64
server.set("sensor.status", "online");    // string → String
server.set("sensor.active", true);        // boolean → Bool
server.set("sensor.updated", new Date()); // Date → Timestamp

// Update a value — all connected clients get it within 100ms
setInterval(() => {
  server.set("sensor.temp", 20 + Math.random() * 10);
}, 1000);

// Read back, list, delete
server.get("sensor.temp");     // 23.5
server.keys;                   // ["sensor.temp", "sensor.status", ...]
server.clear("sensor.active"); // remove one key
server.clear();                // remove all keys
```

**Client:**

```typescript
import { DanWebSocketClient } from "dan-websocket";

const client = new DanWebSocketClient("ws://localhost:8080");

// Fires once initial sync is complete
client.onReady(() => {
  console.log("Temperature:", client.get("sensor.temp"));
  console.log("All keys:", client.keys);
});

// Fires on every value update (including initial sync)
client.onReceive((key, value) => {
  document.getElementById(key)!.textContent = String(value);
});

client.connect();
```

### 2. Individual Mode — per-user data via principals

Perfect for games, user dashboards, personalized data.

A **principal** = one authenticated user. All their sessions (PC, mobile, other tabs) share the same state automatically.

**Server:**

```typescript
import { DanWebSocketServer } from "dan-websocket/server";

const server = new DanWebSocketServer({ port: 8080, mode: "individual" });

// Enable authentication
server.enableAuthorization(true);
server.onAuthorize(async (uuid, token) => {
  const user = await verifyJWT(token);
  server.authorize(uuid, token, user.name);  // 3rd arg = principal name
});

// Set data per principal — no schema, just set
server.principal("alice").set("score", 100);
server.principal("alice").set("name", "Alice");
server.principal("alice").set("rank", 1);

server.principal("bob").set("score", 50);
server.principal("bob").set("name", "Bob");

// Alice opens on PC and mobile → both sessions see score=100
// Bob's sessions see score=50
// Update alice → all her sessions get it instantly
server.principal("alice").set("score", 200);
```

**Client:**

```typescript
import { DanWebSocketClient } from "dan-websocket";

const client = new DanWebSocketClient("ws://localhost:8080");

// Authenticate after connecting
client.onConnect(() => {
  client.authorize(myJWTToken);
});

client.onReady(() => {
  console.log("My score:", client.get("score"));   // 100 (if alice)
  console.log("My name:", client.get("name"));     // "Alice"
});

client.onReceive((key, value) => {
  if (key === "score") updateScoreUI(value);
});

// Auto-reconnection is built-in
client.onReconnecting((attempt, delay) => {
  showStatus(`Reconnecting... attempt ${attempt}`);
});

client.onReconnect(() => {
  showStatus("Connected");
});

client.connect();
```

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                     SERVER                          │
│                                                     │
│  Broadcast Mode:                                    │
│    server.set("temp", 23.5) ──▶ All clients         │
│                                                     │
│  Individual Mode:                                   │
│    Principal "alice" ─── Shared State (1 copy)      │
│      ├── Session (PC browser)  ── same data         │
│      ├── Session (mobile app)  ── same data         │
│      └── Session (tablet)      ── same data         │
│                                                     │
│    Principal "bob" ─── Shared State (1 copy)        │
│      └── Session (laptop)      ── own data          │
└──────────────────────┬──────────────────────────────┘
                       │ Binary WebSocket (DanProtocol v3.0)
                       ▼
┌─────────────────────────────────────────────────────┐
│                     CLIENT                          │
│                                                     │
│  client.get("temp")  → 23.5                         │
│  client.onReceive((key, val) => ...)                │
│  client.keys         → ["temp", "status", ...]      │
│                                                     │
│  Auto: reconnection, heartbeat, recovery            │
└─────────────────────────────────────────────────────┘
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

### Server — Individual Mode

```typescript
const server = new DanWebSocketServer({ port: 8080, mode: "individual" });
```

| Method | Description |
|--------|-------------|
| `server.principal(name).set(key, value)` | Set for principal |
| `server.principal(name).get(key)` | Read value |
| `server.principal(name).keys` | List keys |
| `server.principal(name).clear(key)` | Remove one key |
| `server.principal(name).clear()` | Remove all keys |

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
| `client.get(key)` | Current value (`undefined` if not received) |
| `client.keys` | All received key paths |
| `client.id` | This client's UUIDv7 (stable across reconnects) |
| `client.state` | Connection state string |

| Event | Callback |
|-------|----------|
| `client.onConnect(cb)` | WebSocket opened |
| `client.onReady(cb)` | Initial sync complete, `get()` works |
| `client.onReceive(cb)` | Value update: `(key, value)` |
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
