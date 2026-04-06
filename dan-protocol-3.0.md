# DanProtocol v3.0 Specification

> April 2026 | Unidirectional Real-Time State Synchronization

---

## 1. What is DanProtocol?

DanProtocol is a **lightweight binary protocol** designed for pushing real-time state from a server to connected clients. It runs over WebSocket, TCP, serial, or any byte-stream transport.

### Key Design Decisions

| Decision | Why |
|----------|-----|
| **Server→Client only** | Simplifies protocol, reduces attack surface. Clients are pure receivers. |
| **Binary wire format** | Minimal bandwidth. A boolean update is 9 bytes total (vs ~30+ bytes for JSON). |
| **DLE-based framing** | Self-synchronizing frames without length prefixes. Robust on unreliable streams. |
| **Auto-typed** | No schema declaration needed. Types are detected from values. |
| **Principal-based** | State is per-authenticated-user, not per-connection. Multiple devices share one state. |

---

## 2. Wire Format

### 2.1 Control Characters

| Hex | Name | Purpose |
|-----|------|---------|
| `0x10` | DLE | Escape prefix. Never appears as raw data. |
| `0x02` | STX | Start of frame (after DLE). |
| `0x03` | ETX | End of frame (after DLE). |
| `0x05` | ENQ | Heartbeat signal (after DLE). |

### 2.2 Frame Layout

```
┌────────┬────────┬───────────┬────────┬───────────┬──────────┬────────┬────────┐
│DLE 0x10│STX 0x02│FrameType  │ KeyID  │ DataType  │ Payload  │DLE 0x10│ETX 0x03│
│ 1 byte │ 1 byte │  1 byte   │2 bytes │  1 byte   │ N bytes  │ 1 byte │ 1 byte │
└────────┴────────┴───────────┴────────┴───────────┴──────────┴────────┴────────┘
                  └──────── DLE-escaped body ────────────────┘
```

- **All multi-byte numbers**: Big Endian (network byte order)
- **Minimum frame**: 8 bytes (signal frame, no payload)
- **DLE escaping**: Any `0x10` in the body becomes `0x10 0x10`

### 2.3 Heartbeat (not a frame)

```
┌────────┬────────┐
│DLE 0x10│ENQ 0x05│
│ 1 byte │ 1 byte │
└────────┴────────┘
```

Sent every 10 seconds by both sides. If not received within 15 seconds, the connection is considered dead.

---

## 3. Frame Types

### 3.1 Data Frames

| Code | Name | Direction | Payload |
|------|------|-----------|---------|
| `0x00` | Server Key Registration | Server→Client | UTF-8 keyPath |
| `0x01` | Server Value | Server→Client | Typed value |

### 3.2 Handshake Frames

| Code | Name | Direction | Payload |
|------|------|-----------|---------|
| `0x04` | Server SYNC | Server→Client | — |
| `0x05` | Client READY | Client→Server | — |

### 3.3 Control Frames

| Code | Name | Direction | Payload |
|------|------|-----------|---------|
| `0x08` | Error | Both | UTF-8 message |
| `0x09` | Server RESET | Server→Client | — |
| `0x0A` | Client RESYNC_REQ | Client→Server | — |

### 3.4 Authentication Frames

| Code | Name | Direction | Payload |
|------|------|-----------|---------|
| `0x0D` | IDENTIFY | Client→Server | 16 bytes UUIDv7 |
| `0x0E` | AUTH | Client→Server | UTF-8 token |
| `0x0F` | AUTH_OK | Server→Client | — |
| `0x10` | AUTH_FAIL | Server→Client | UTF-8 reason |

---

## 4. Data Types

Types are auto-detected from application values. No explicit declaration needed.

| Code | Type | Size | JS / Java Type |
|------|------|------|----------------|
| `0x00` | Null | 0 | `null` |
| `0x01` | Bool | 1 | `boolean` / `Boolean` |
| `0x02` | Uint8 | 1 | — |
| `0x03` | Uint16 | 2 | — |
| `0x04` | Uint32 | 4 | — / `Integer` |
| `0x05` | Uint64 | 8 | `bigint` / `Long` |
| `0x06` | Int32 | 4 | — / `Integer` |
| `0x07` | Int64 | 8 | `bigint` / `Long` |
| `0x08` | Float32 | 4 | — / `Float` |
| `0x09` | Float64 | 8 | `number` / `Double` |
| `0x0A` | String | var | `string` / `String` |
| `0x0B` | Binary | var | `Uint8Array` / `byte[]` |
| `0x0C` | Timestamp | 8 | `Date` / `Date` |

### Auto-Detection Rules

| Value | → Wire Type |
|-------|-------------|
| `null` | Null |
| `true` / `false` | Bool |
| JS `number` / Java `Double` | Float64 |
| Java `Integer` | Int32 |
| Java `Float` | Float32 |
| JS `bigint` ≥ 0 / Java `Long` ≥ 0 | Uint64 |
| JS `bigint` < 0 / Java `Long` < 0 | Int64 |
| `string` / `String` | String |
| `Uint8Array` / `byte[]` | Binary |
| `Date` | Timestamp |

---

## 5. DLE Escaping

### Why?

DLE (`0x10`) is the escape character. The parser treats `0x10` as a control prefix, never as data. If payload data contains `0x10`, it must be doubled.

### Rules

| Wire Bytes | Meaning |
|------------|---------|
| `0x10 0x02` | Frame start |
| `0x10 0x03` | Frame end |
| `0x10 0x05` | Heartbeat |
| `0x10 0x10` | Literal `0x10` in data |
| `0x10 [other]` | Protocol error |

### Example

Payload `48 10 65` (contains `0x10`):
- Encoded: `48 10 10 65`
- Parser reads: `48` → data, `10 10` → literal `0x10`, `65` → data
- Decoded: `48 10 65` (original restored)

---

## 6. Protocol Flows

### 6.1 Connection (No Auth)

```
Client                         Server
  │                               │
  │── IDENTIFY (UUIDv7) ────────▶│  Create session
  │                               │
  │◀── Key Reg (key1, float64) ──│  ┐
  │◀── Key Reg (key2, string)  ──│  │ Register keys
  │◀── Server SYNC ──────────────│  ┘
  │                               │
  │── Client READY ──────────────▶│
  │                               │
  │◀── Value (key1 = 23.5) ──────│  ┐ Full state sync
  │◀── Value (key2 = "hello") ───│  ┘
  │                               │
  │◀── Value (key1 = 24.1) ──────│  Live updates...
```

### 6.2 Connection (With Auth)

```
Client                         Server
  │                               │
  │── IDENTIFY (UUIDv7) ────────▶│  → tmpSessions
  │── AUTH (token) ──────────────▶│  → verify → determine principal
  │◀── AUTH_OK ──────────────────│  → bind to principal
  │                               │
  │◀── Key Reg ... ──────────────│  (same as above)
  │◀── Server SYNC ──────────────│
  │── Client READY ──────────────▶│
  │◀── Values ... ───────────────│
```

### 6.3 Dynamic Key Addition

When `set()` is called with a new key:

```
Server                         Client
  │                               │
  │── Server RESET ──────────────▶│  Discard all keys
  │── Key Reg (all current) ────▶│  Re-register
  │── Server SYNC ──────────────▶│
  │                               │
  │◀── Client READY ─────────────│
  │── Values (all current) ─────▶│  Full resync
```

### 6.4 Recovery

If client receives a value for an unknown key:

```
Client                         Server
  │── Client RESYNC_REQ ────────▶│
  │                               │
  │◀── Server RESET ─────────────│
  │◀── Key Reg (all) ───────────│
  │◀── Server SYNC ─────────────│
  │── Client READY ─────────────▶│
  │◀── Values (all) ────────────│
```

---

## 7. Batch Framing

Multiple frames can be concatenated in one transport message:

```
[DLE STX ... DLE ETX][DLE STX ... DLE ETX][DLE STX ... DLE ETX]
└───── frame 1 ─────┘└───── frame 2 ─────┘└───── frame 3 ─────┘
```

The bulk queue batches frames every **100ms** and sends them as one message. Value frames for the same key are **deduplicated** within the window (only the latest value is sent).

---

## 8. KeyPath Convention

```
sensor.temperature       ← dot-separated segments
root.users.0.name        ← numeric segments = array indices
input.joystick.x         ← any depth
```

Rules:
- Segments: `[a-zA-Z0-9_]+`
- Separator: `.`
- Max length: 200 bytes (UTF-8)
- No leading/trailing/consecutive dots
- No spaces

---

## 9. Wire Examples

### Bool value `true` for Key ID 0x0001

```
10 02 01 00 01 01 01 10 03
│  │  │  └──┘  │  │  │  │
│  │  │  KeyID │  │  DLE ETX
│  │  FrameType  │  payload: 0x01 = true
DLE STX  =0x01   DataType=0x01 (bool)
```

### Signal frame (Server SYNC)

```
10 02 04 00 00 00 10 03     (8 bytes, no payload)
```

### String "Alice" for Key ID 0x0002

```
10 02 01 00 02 0a 41 6c 69 63 65 10 03
```

---

## 10. Implementations

| Language | Package | Install |
|----------|---------|---------|
| TypeScript | [`dan-websocket`](https://www.npmjs.com/package/dan-websocket) | `npm install dan-websocket` |
| Java | `io.github.justdancecloud:dan-websocket` | Gradle/Maven |

Both implementations are **wire-compatible**: a TypeScript server can serve Java clients and vice versa.
