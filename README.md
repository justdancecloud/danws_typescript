# dan-websocket

Lightweight binary protocol library for **bidirectional real-time state synchronization** over WebSocket, TCP, or any byte-stream transport.

## Why?

Existing WebSocket libraries transmit JSON text, which is verbose and requires parsing overhead. **dan-websocket** uses a compact binary protocol (DanProtocol v2.0) that:

- Minimizes bandwidth with typed binary serialization
- Eliminates JSON parse/stringify overhead
- Provides built-in key registration, state synchronization, and recovery
- Supports automatic reconnection with offline queuing

## Who is it for?

- **IoT dashboards** — push sensor readings to browser clients
- **Multiplayer games** — low-latency bidirectional state sync
- **Financial data feeds** — real-time price streaming
- **Remote control systems** — send commands, receive device state
- Any application needing efficient real-time state synchronization

## Installation

```bash
npm install dan-websocket
```

## Quick Start

### Client

```typescript
import { DanWebSocketClient, DataType } from "dan-websocket";

const client = new DanWebSocketClient("ws://localhost:8080/ws");

client.tx.updateKeys([
  { path: "input.joystick.x", type: DataType.Float32 },
]);

client.onReady(() => {
  client.tx.set("input.joystick.x", -0.75);
  console.log("Server says:", client.rx.get("greeting"));
});

client.rx.onReceive((key, value) => {
  console.log(`${key} = ${value}`);
});

client.connect();
```

### Server

```typescript
import { DanWebSocketServer, DataType } from "dan-websocket/server";

const server = new DanWebSocketServer({ port: 8080, path: "/ws", mode: "individual" });

server.onConnection((session) => {
  session.tx.updateKeys([
    { path: "greeting", type: DataType.String },
  ]);
  session.tx.set("greeting", `Hello, ${session.id}`);

  session.rx.onReceive((key, value) => {
    console.log(`${session.id}: ${key} = ${value}`);
  });
});
```

### Standalone Protocol (no transport)

```typescript
import { DanProtocol, FrameType, DataType } from "dan-websocket/protocol";

// Encode a frame
const bytes = encode({
  frameType: FrameType.ServerValue,
  keyId: 0x0001,
  dataType: DataType.Float32,
  payload: 23.5,
});

// Decode frames
const frames = decode(bytes);

// Stream parser for arbitrary byte chunks
const parser = createStreamParser();
parser.onFrame((frame) => console.log(frame));
parser.onHeartbeat(() => console.log("heartbeat"));
parser.feed(someBytes);
```

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

## Module Exports

| Import Path | Contents |
|-------------|----------|
| `dan-websocket` | `DanWebSocketClient`, `DataType`, `DanWSError` |
| `dan-websocket/server` | `DanWebSocketServer`, `DataType`, `DanWSError` |
| `dan-websocket/protocol` | `encode`, `decode`, `encodeBatch`, `encodeHeartbeat`, `createStreamParser`, `DataType`, `FrameType`, `DanWSError` |

## Development Status

- [x] Phase 1: Protocol Core (encode/decode, DLE escaping, stream parser, all 13 data types)
- [x] Phase 2: State Machine (handshake, key registry, auth, recovery)
- [x] Phase 3: Connection Manager (WebSocket, bulk queue, heartbeat, reconnection)
- [x] Phase 4: Public API (Client, Server, Session, TX/RX Channel) + E2E Tests
- [ ] Phase 5: Additional Integration Testing
- [ ] Phase 6: npm Publish

## License

MIT
