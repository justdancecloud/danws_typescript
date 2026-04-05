# dan-websocket

Lightweight binary protocol library for **real-time state synchronization** from server to client.

## Why?

Existing WebSocket libraries transmit JSON text, which is verbose and requires parsing overhead. **dan-websocket** uses a compact binary protocol (DanProtocol v2.0) that:

- Minimizes bandwidth with typed binary serialization
- Eliminates JSON parse/stringify overhead
- Provides built-in key registration, state synchronization, and recovery
- Supports automatic reconnection with offline queuing
- **Principal-based shared memory** — one state per authenticated user, synced to all their sessions

## Who is it for?

- **IoT dashboards** — push sensor readings to browser clients
- **Multiplayer games** — server-authoritative state sync to players
- **Financial data feeds** — real-time price streaming
- **Remote monitoring** — push device state to operators
- Any application needing efficient server→client state synchronization

## Installation

```bash
npm install dan-websocket
```

## Quick Start

### Server

```typescript
import { DanWebSocketServer, DataType } from "dan-websocket/server";

const server = new DanWebSocketServer({ port: 8080, path: "/ws" });

// Enable authentication
server.enableAuthorization(true);
server.onAuthorize((uuid, token) => {
  const user = verifyToken(token);
  server.authorize(uuid, token, user.name); // 3rd arg = principal
});

// Set up data per principal (shared across all sessions of the same user)
server.tx.principal("alice").updateKeys([
  { path: "player.score", type: DataType.Uint32 },
  { path: "player.name", type: DataType.String },
]);
server.tx.principal("alice").set("player.score", 0);
server.tx.principal("alice").set("player.name", "Alice");

// Update — all of alice's sessions (tabs, devices) get the update
server.tx.principal("alice").set("player.score", 100);

// Query sessions
server.getSessionsByPrincipal("alice"); // all alice's sessions
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

## Supported Data Types

| Type | JS Type | Size |
|------|---------|------|
| Null | `null` | 0 bytes |
| Bool | `boolean` | 1 byte |
| Uint8 | `number` | 1 byte |
| Uint16 | `number` | 2 bytes |
| Uint32 | `number` | 4 bytes |
| Uint64 | `bigint` | 8 bytes |
| Int32 | `number` | 4 bytes |
| Int64 | `bigint` | 8 bytes |
| Float32 | `number` | 4 bytes |
| Float64 | `number` | 8 bytes |
| String | `string` | variable |
| Binary | `Uint8Array` | variable |
| Timestamp | `Date` | 8 bytes |

## API Reference

### Server

| Method | Description |
|--------|-------------|
| `server.tx.principal(name)` | Get shared TX state for a principal |
| `.updateKeys(keys)` | Register keys with types |
| `.set(key, value)` | Set value (syncs to all sessions) |
| `.get(key)` | Read current value |
| `.keys` | List registered key paths |
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
| `client.onReconnecting(cb)` | Reconnect attempt |
| `client.onReconnect(cb)` | Reconnection successful |
| `client.onError(cb)` | Protocol error |

## Development Status

- [x] Phase 1: Protocol Core (encode/decode, DLE escaping, stream parser)
- [x] Phase 2: State Machine (handshake, key registry, auth, recovery)
- [x] Phase 3: Connection Manager (bulk queue, heartbeat, reconnection)
- [x] Phase 4: Public API (Principal-based Server, Client) + E2E Tests
- [ ] Phase 5: npm Publish

## License

MIT
