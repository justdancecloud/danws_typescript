# dan-websocket

Lightweight binary protocol library for **real-time state synchronization** from server to client.

## Why?

Existing WebSocket libraries transmit JSON text, which is verbose and requires parsing overhead. **dan-websocket** uses a compact binary protocol (DanProtocol v2.0) that:

- Minimizes bandwidth with typed binary serialization
- Eliminates JSON parse/stringify overhead
- Auto-detects data types — just `set(key, value)`
- **Principal-based shared memory** — one state per authenticated user, synced to all their sessions
- Supports automatic reconnection with exponential backoff

## Who is it for?

- **IoT dashboards** — push sensor readings to browser clients
- **Multiplayer games** — server-authoritative state sync to players
- **Financial data feeds** — real-time price streaming
- **Remote monitoring** — push device state to operators

## Installation

```bash
npm install dan-websocket
```

## Quick Start

### Server

```typescript
import { DanWebSocketServer } from "dan-websocket/server";

const server = new DanWebSocketServer({ port: 8080, path: "/ws" });

// Just set values — types are auto-detected
server.tx.principal("alice").set("player.score", 0);
server.tx.principal("alice").set("player.name", "Alice");
server.tx.principal("alice").set("player.alive", true);

// Update — all of alice's sessions (tabs, devices) get it
server.tx.principal("alice").set("player.score", 100);

// Read back
server.tx.principal("alice").get("player.score"); // 100
server.tx.principal("alice").keys;                // ["player.score", "player.name", "player.alive"]

// Clean up
server.tx.principal("alice").clear("player.alive"); // remove one key
server.tx.principal("alice").clear();                // remove all keys

// Authentication
server.enableAuthorization(true);
server.onAuthorize((uuid, token) => {
  const user = verifyToken(token);
  server.authorize(uuid, token, user.name); // 3rd arg = principal
});

// Session management
server.getSessionsByPrincipal("alice"); // all of alice's sessions
```

### Client

```typescript
import { DanWebSocketClient } from "dan-websocket";

const client = new DanWebSocketClient("ws://localhost:8080/ws");

client.onConnect(() => {
  client.authorize(getToken());
});

client.onReady(() => {
  console.log("Score:", client.get("player.score"));
  console.log("Keys:", client.keys);
});

client.onReceive((key, value) => {
  console.log(`${key} = ${value}`);
});

client.connect();
```

## Architecture

```
Principal "alice" ─── Shared State (1 copy in memory)
  ├── Session A (PC browser)   ─── same data
  ├── Session B (mobile app)   ─── same data
  └── Session C (another tab)  ─── same data
```

- **Server→Client only** — the server pushes state, clients receive
- **Principal-based** — data is managed per authenticated user, not per connection
- **No duplication** — one state per principal, shared across all sessions
- **Auto-type detection** — no need to declare types, just `set(key, value)`

## Supported Data Types (auto-detected)

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

## API Reference

### Server — `server.tx.principal(name)`

| Method | Description |
|--------|-------------|
| `.set(key, value)` | Set value (auto-type, syncs to all sessions) |
| `.get(key)` | Read current value |
| `.keys` | List registered key paths |
| `.clear(key)` | Remove a single key |
| `.clear()` | Remove all keys |

### Server — management

| Method | Description |
|--------|-------------|
| `server.enableAuthorization(enabled, opts?)` | Enable/disable auth |
| `server.authorize(uuid, token, principal)` | Accept auth, assign principal |
| `server.reject(uuid, reason?)` | Reject auth |
| `server.getSession(uuid)` | Get session by ID |
| `server.getSessionsByPrincipal(name)` | Get all sessions for a principal |
| `server.isConnected(uuid)` | Check if session is connected |

### Client

| Method | Description |
|--------|-------------|
| `client.connect()` | Connect to server |
| `client.disconnect()` | Disconnect |
| `client.authorize(token)` | Send auth token |
| `client.get(key)` | Get current value |
| `client.keys` | List received key paths |
| `client.onConnect(cb)` | Connection established |
| `client.onReady(cb)` | Sync complete, data available |
| `client.onReceive(cb)` | Value received: `(key, value)` |
| `client.onDisconnect(cb)` | Connection lost |
| `client.onReconnecting(cb)` | Reconnect attempt: `(attempt, delay)` |
| `client.onReconnect(cb)` | Reconnection successful |
| `client.onReconnectFailed(cb)` | All retries exhausted |
| `client.onError(cb)` | Protocol error |

## License

MIT
