# dan-websocket

Lightweight binary protocol library for **real-time state synchronization** from server to client.

## Why?

Existing WebSocket libraries transmit JSON text, which is verbose and requires parsing overhead. **dan-websocket** uses a compact binary protocol (DanProtocol v2.0) that:

- Minimizes bandwidth with typed binary serialization
- Auto-detects data types — just `set(key, value)`
- **1:N architecture** — one state syncs to many client sessions
- Automatic reconnection, heartbeat, and recovery
- Principal-based shared memory for per-user state management

## Installation

```bash
npm install dan-websocket
```

## Two Modes

### Broadcast Mode — all clients get the same data

```typescript
import { DanWebSocketServer } from "dan-websocket/server";

const server = new DanWebSocketServer({ port: 8080, mode: "broadcast" });

// Set data — all connected clients receive it
server.set("sensor.temp", 23.5);
server.set("status", "online");

// Read, list, clear
server.get("sensor.temp");    // 23.5
server.keys;                  // ["sensor.temp", "status"]
server.clear("status");       // remove one key
server.clear();               // remove all
```

### Individual Mode — per-user (principal) data

```typescript
const server = new DanWebSocketServer({ port: 8080, mode: "individual" });

// Each principal has its own shared state
server.principal("alice").set("score", 100);
server.principal("bob").set("score", 200);

// Alice's sessions (PC, mobile, etc.) all get score=100
// Bob's sessions all get score=200

// Authentication determines which principal a client belongs to
server.enableAuthorization(true);
server.onAuthorize((uuid, token) => {
  const user = verifyToken(token);
  server.authorize(uuid, token, user.name); // 3rd arg = principal
});
```

### Client (same for both modes)

```typescript
import { DanWebSocketClient } from "dan-websocket";

const client = new DanWebSocketClient("ws://localhost:8080");

client.onConnect(() => {
  client.authorize(getToken()); // if auth enabled
});

client.onReady(() => {
  console.log(client.get("score"));  // 100
  console.log(client.keys);          // ["score"]
});

client.onReceive((key, value) => {
  console.log(`${key} = ${value}`);  // real-time updates
});

client.connect();
```

## Architecture

```
Broadcast:
  Server State ─── 1 copy
    ├── Client A ── same data
    ├── Client B ── same data
    └── Client C ── same data

Individual:
  Principal "alice" ─── 1 copy
    ├── Session (PC)     ── same data
    └── Session (mobile) ── same data
  Principal "bob" ─── 1 copy
    └── Session (tablet) ── own data
```

## Auto-detected Data Types

| JS Type | Wire Type | Size |
|---------|-----------|------|
| `null` | Null | 0 bytes |
| `boolean` | Bool | 1 byte |
| `number` | Float64 | 8 bytes |
| `bigint` (≥0) | Uint64 | 8 bytes |
| `bigint` (<0) | Int64 | 8 bytes |
| `string` | String | variable |
| `Uint8Array` | Binary | variable |
| `Date` | Timestamp | 8 bytes |

## API

### Server — Broadcast mode

| Method | Description |
|--------|-------------|
| `server.set(key, value)` | Set value, sync to all clients |
| `server.get(key)` | Read value |
| `server.keys` | List keys |
| `server.clear(key?)` | Remove key(s) |

### Server — Individual mode

| Method | Description |
|--------|-------------|
| `server.principal(name).set(key, value)` | Set value for principal |
| `server.principal(name).get(key)` | Read value |
| `server.principal(name).keys` | List keys |
| `server.principal(name).clear(key?)` | Remove key(s) |

### Server — Common

| Method | Description |
|--------|-------------|
| `server.enableAuthorization(enabled, opts?)` | Enable auth |
| `server.authorize(uuid, token, principal)` | Accept auth |
| `server.reject(uuid, reason?)` | Reject auth |
| `server.getSession(uuid)` | Get session |
| `server.getSessionsByPrincipal(name)` | Get sessions by principal |
| `server.isConnected(uuid)` | Check connection |
| `server.close()` | Shutdown |

### Client

| Method | Description |
|--------|-------------|
| `client.connect()` | Connect |
| `client.disconnect()` | Disconnect |
| `client.authorize(token)` | Auth |
| `client.get(key)` | Get value |
| `client.keys` | List keys |
| `client.onReady(cb)` | Sync complete |
| `client.onReceive(cb)` | Value update: `(key, value)` |
| `client.onConnect(cb)` | Connected |
| `client.onDisconnect(cb)` | Disconnected |
| `client.onReconnecting(cb)` | Retrying: `(attempt, delay)` |
| `client.onReconnect(cb)` | Reconnected |
| `client.onReconnectFailed(cb)` | Gave up |
| `client.onError(cb)` | Error |

## License

MIT
