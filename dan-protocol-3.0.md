# DanProtocol v3.2 Specification

> April 2026 | Real-Time State Synchronization with Auto-Flatten & Array Operations

---

## 1. What is DanProtocol?

DanProtocol is a **lightweight binary protocol** designed for pushing real-time state from a server to connected clients. It runs over WebSocket, TCP, serial, or any byte-stream transport.

### Key Design Decisions

| Decision | Why |
|----------|-----|
| **Binary wire format** | Minimal bandwidth. A boolean update is ~13 bytes total (vs ~30+ bytes for JSON). |
| **DLE-based framing** | Self-synchronizing frames without length prefixes. Robust on unreliable streams. |
| **Auto-typed** | No schema declaration needed. 13 types detected from values. |
| **4-byte KeyID** | Supports 4B+ unique keys for auto-flatten at scale. |
| **Auto-flatten** | Objects/arrays expand into dot-path leaf keys at API layer. Only changed fields go on wire. |
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
+---------+---------+-----------+---------+----------+----------+---------+---------+
| DLE     | STX     | FrameType | KeyID   | DataType | Payload  | DLE     | ETX     |
| 0x10    | 0x02    | 1 byte    | 4 bytes | 1 byte   | N bytes  | 0x10    | 0x03    |
+---------+---------+-----------+---------+----------+----------+---------+---------+
                    |<---------- DLE-escaped body ------------>|
```

- **All multi-byte numbers**: Big Endian (network byte order)
- **KeyID**: 4 bytes unsigned (0x00000000 ~ 0xFFFFFFFF)
- **Minimum frame**: 10 bytes (signal frame: 2 framing + 6 body + 2 framing)
- **DLE escaping**: Any `0x10` in the body becomes `0x10 0x10`

### 2.3 Heartbeat (not a frame)

```
+---------+---------+
| DLE     | ENQ     |
| 0x10    | 0x05    |
+---------+---------+
```

Sent every 10 seconds by both sides. If not received within 15 seconds, the connection is considered dead.

---

## 3. Frame Types

### 3.1 Server to Client — Data

| Code | Name | Payload |
|------|------|---------|
| `0x00` | ServerKeyRegistration | UTF-8 keyPath |
| `0x01` | ServerValue | Typed value |

### 3.2 Client to Server — Data (Topic Mode)

| Code | Name | Payload |
|------|------|---------|
| `0x02` | ClientKeyRegistration | UTF-8 keyPath |
| `0x03` | ClientValue | Typed value |

### 3.3 Handshake

| Code | Name | Direction | Payload |
|------|------|-----------|---------|
| `0x04` | ServerSync | S→C | — |
| `0x05` | ClientReady | C→S | — |
| `0x06` | ClientSync | C→S | — |
| `0x07` | ServerReady | S→C | — |

### 3.4 Control

| Code | Name | Direction | Payload |
|------|------|-----------|---------|
| `0x08` | Error | Both | UTF-8 message |
| `0x09` | ServerReset | S→C | — |
| `0x0A` | ClientResyncReq | C→S | — |
| `0x0B` | ClientReset | C→S | — |
| `0x0C` | ServerResyncReq | S→C | — |

### 3.6 Array Operations

| Code | Name | Direction | Payload |
|------|------|-----------|---------|
| `0x20` | ArrayShiftLeft | S→C | Int32 shift count |
| `0x21` | ArrayShiftRight | S→C | Int32 shift count |

**ARRAY_SHIFT_LEFT (0x20):**

Used to optimize array left-shift patterns (e.g., sliding window: `[1,2,3,4,5]` -> `[2,3,4,5,6]`). Instead of re-sending all shifted element values, the server sends a single ARRAY_SHIFT_LEFT frame.

- **KeyID**: keyId of `{arrayKey}.length` (identifies which array)
- **DataType**: Int32 (0x06)
- **Payload**: shift count as int32 (4 bytes) — how many elements shifted off the front

**Client action on receiving ARRAY_SHIFT_LEFT(keyId=lengthKeyId, payload=k):**

1. Look up the path for `lengthKeyId` (e.g., `data.length`)
2. Derive the array prefix (e.g., `data`)
3. Read current length from store
4. For `i` from `0` to `length - k - 1`: copy value at `{prefix}.{i+k}` to `{prefix}.{i}`
5. Update length to `length - k`
6. Fire callbacks for `{prefix}.length`

**ARRAY_SHIFT_RIGHT (0x21):**

Used to optimize array right-shift patterns (e.g., prepend: `[1,2,3,4,5]` -> `[0,1,2,3,4,5]`). Instead of re-sending all shifted element values, the server sends a single ARRAY_SHIFT_RIGHT frame.

- **KeyID**: keyId of `{arrayKey}.length` (identifies which array)
- **DataType**: Int32 (0x06)
- **Payload**: shift count as int32 (4 bytes) — how many positions to shift right

**Client action on receiving ARRAY_SHIFT_RIGHT(keyId=lengthKeyId, payload=k):**

1. Look up the path for `lengthKeyId` (e.g., `data.length`)
2. Derive the array prefix (e.g., `data`)
3. Read current length from store
4. For `i` from `length - 1` down to `0`: copy value at `{prefix}.{i}` to `{prefix}.{i+k}`
5. Do NOT update length (server sends new head elements + length update separately)
6. Fire callbacks for `{prefix}.length`

**Server-side array diff detection (Smart Detection Algorithm):**

When `set(key, array)` is called and a previous array exists for that key, the server compares old and new arrays to detect shift patterns. The algorithm supports **any shift amount** — not limited to small shifts.

1. **Left shift**: Compare `old[k:]` against `new[0:matchLen]` for any valid `k`
   - If a contiguous match is found: send ARRAY_SHIFT_LEFT(k) + new tail elements + length update if changed
   - Common patterns: `shift() + push()`, `splice(0, k) + append`, sliding windows
2. **Right shift**: Compare `old[0:matchLen]` against `new[k:k+matchLen]` for any valid `k`
   - If a contiguous match is found: send ARRAY_SHIFT_RIGHT(k) + new head elements + length update if changed
   - Common patterns: `unshift()`, prepend operations
3. **Append only**: If `new.length > old.length` and `old` is a prefix of `new`, only new tail elements are sent
4. **Pop only**: If `new.length < old.length` and `new` is a prefix of `old`, only the length update is sent
5. If no shift pattern detected: fall through to normal flatten (field-level dedup handles unchanged elements)

**Frame count comparison:**

| Scenario | Without ARRAY_SHIFT | With ARRAY_SHIFT |
|----------|-------------------|-----------------|
| 100-element array, shift left by 1 | 101 frames | 3 frames |
| 1000-element array, shift left by 1 | 1001 frames | 3 frames |
| 50-element array, shift left by 5 | 51 frames | 7 frames |
| Append 1 element | 2 frames | 2 frames |
| Pop 1 element | 1 frame | 1 frame |

This optimization reduces a shift of N elements from N value frames to 1 ARRAY_SHIFT frame + only the truly new values.

**Wire example — left shift by 1 on array "scores" (length keyId=0x00000005):**

```
10 02 20 00 00 00 05 06 00 00 00 01 10 03
|  |  |  |--------|  |  |--------| |  |
|  |  |    KeyID   |  |  payload   DLE ETX
|  |  FrameType   DataType=Int32
DLE STX  =0x20     =0x06         shiftCount=1
```

**Wire example — right shift by 1 on array "scores" (length keyId=0x00000005):**

```
10 02 21 00 00 00 05 06 00 00 00 01 10 03
|  |  |  |--------|  |  |--------| |  |
|  |  |    KeyID   |  |  payload   DLE ETX
|  |  FrameType   DataType=Int32
DLE STX  =0x21     =0x06         shiftCount=1
```

### 3.5 Authentication

| Code | Name | Direction | Payload |
|------|------|-----------|---------|
| `0x0D` | Identify | C→S | 16 bytes UUIDv7 |
| `0x0E` | Auth | C→S | UTF-8 token |
| `0x0F` | AuthOk | S→C | — |
| `0x11` | AuthFail | S→C | UTF-8 reason |

> **Note**: `0x10` is reserved (DLE control character). AuthFail uses `0x11` to avoid collision.

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

| Value | Wire Type |
|-------|-----------|
| `null` | Null |
| `true` / `false` | Bool |
| JS `number` / Java `Double` | Float64 |
| Java `Integer` | Int32 |
| Java `Float` | Float32 |
| JS `bigint` >= 0 / Java `Long` >= 0 | Uint64 |
| JS `bigint` < 0 / Java `Long` < 0 | Int64 |
| `string` / `String` | String |
| `Uint8Array` / `byte[]` | Binary |
| `Date` | Timestamp |
| `{ ... }` / `[...]` (object/array) | **Auto-flatten** (API layer, not a wire type) |

---

## 5. DLE Escaping

### Rules

| Wire Bytes | Meaning |
|------------|---------|
| `0x10 0x02` | Frame start |
| `0x10 0x03` | Frame end |
| `0x10 0x05` | Heartbeat |
| `0x10 0x10` | Literal `0x10` in data |
| `0x10 [other]` | Protocol error |

The entire frame body (FrameType + KeyID + DataType + Payload) is DLE-escaped.

---

## 6. Auto-Flatten (API Layer)

Objects and arrays are expanded into dot-path leaf keys before going on the wire. This is handled at the API layer, not the protocol layer — the wire only carries primitive leaf values.

### Expansion Rules

| Input | Expanded Keys |
|-------|---------------|
| `set("user", { name: "Alice", age: 30 })` | `user.name` = "Alice", `user.age` = 30 |
| `set("scores", [10, 20, 30])` | `scores.0` = 10, `scores.1` = 20, `scores.2` = 30, `scores.length` = 3 |
| `set("data", { items: [{ id: 1 }] })` | `data.items.length` = 1, `data.items.0.id` = 1 |

- Arrays get an automatic `.length` key
- Nested objects flatten recursively (max depth: 10)
- Circular references are detected and rejected
- When an array shrinks, leftover keys are automatically removed
- Unchanged leaf values are not re-transmitted (field-level dedup)

### Topic Mode Wire Prefix

In topic modes, each topic's payload keys are prefixed with `t.<index>.`:

```
topic "board" (index=0): t.0.items.length, t.0.items.0.title, ...
topic "chart" (index=1): t.1.value, t.1.timestamp, ...
```

Client→Server topic subscriptions use `topic.<index>.name` and `topic.<index>.param.<key>` encoding.

---

## 7. Protocol Flows

### 7.1 Connection (No Auth)

```
Client                         Server
  |                               |
  |-- IDENTIFY (UUIDv7) -------->|  Create session
  |                               |
  |<-- Key Reg (key1, float64) --|  Register keys
  |<-- Key Reg (key2, string)  --|
  |<-- Server SYNC --------------|
  |                               |
  |-- Client READY ------------->|
  |                               |
  |<-- Value (key1 = 23.5) ------|  Full state sync
  |<-- Value (key2 = "hello") ---|
  |                               |
  |<-- Value (key1 = 24.1) ------|  Live updates...
```

### 7.2 Connection (With Auth)

```
Client                         Server
  |                               |
  |-- IDENTIFY (UUIDv7) -------->|
  |-- AUTH (token) ------------->|  verify + determine principal
  |<-- AUTH_OK ------------------|  bind to principal
  |                               |
  |<-- Key Reg ... --------------|
  |<-- Server SYNC --------------|
  |-- Client READY ------------->|
  |<-- Values ... ---------------|
```

### 7.3 Topic Subscription (Topic Modes)

```
Client                         Server
  |                               |
  |-- ClientReset -------------->|  Clear previous topic state
  |-- ClientKeyReg (topic.0.name, ...) ->|
  |-- ClientValue (topic.0.name = "board") ->|
  |-- ClientSync --------------->|  Process topic diff
  |                               |
  |<-- ServerReset --------------|  Full state rebuild
  |<-- Key Reg (t.0.items.0.title, ...) -|
  |<-- Server SYNC --------------|
  |-- Client READY ------------->|
  |<-- Values ... ---------------|
```

### 7.4 Recovery

If client receives a value for an unknown key:

```
Client                         Server
  |-- Client RESYNC_REQ ------->|
  |<-- Server RESET ------------|
  |<-- Key Reg (all) ----------|
  |<-- Server SYNC -------------|
  |-- Client READY ------------->|
  |<-- Values (all) ------------|
```

---

## 8. Batch Framing

Multiple frames can be concatenated in one transport message:

```
[DLE STX ... DLE ETX][DLE STX ... DLE ETX][DLE STX ... DLE ETX]
```

The bulk queue batches frames every **100ms** and sends them as one message. Value frames for the same key are **deduplicated** within the window (only the latest value is sent).

---

## 9. KeyPath Convention

```
sensor.temperature       -- dot-separated segments
root.users.0.name        -- numeric segments = array indices
t.0.items.3.title        -- topic wire prefix
```

Rules:
- Segments: `[a-zA-Z0-9_]+`
- Separator: `.`
- Max length: 200 bytes (UTF-8)
- No leading/trailing/consecutive dots

---

## 10. Wire Examples (4-byte KeyID)

### Bool value `true` for KeyID 0x00000001

```
10 02 01 00 00 00 01 01 01 10 03
|  |  |  |--------|  |  |  |  |
|  |  |    KeyID   |  |  DLE ETX
|  |  FrameType   DataType
DLE STX  =0x01    =0x01(bool)  payload: 0x01=true
```

### Signal frame (Server SYNC, KeyID=0)

```
10 02 04 00 00 00 00 00 10 03     (10 bytes total)
```

### String "Alice" for KeyID 0x00000002

```
10 02 01 00 00 00 02 0a 41 6c 69 63 65 10 03
```

### KeyID 0x00000010 (contains DLE byte, escaped)

```
10 02 01 00 00 00 10 10 0a ... 10 03
              ^^^^^^^^^ 0x10 escaped to 0x10 0x10
```

---

## 11. Implementations

| Language | Package | Install |
|----------|---------|---------|
| TypeScript | [`dan-websocket`](https://www.npmjs.com/package/dan-websocket) | `npm install dan-websocket` |
| Java | [`io.github.justdancecloud:dan-websocket`](https://central.sonatype.com/artifact/io.github.justdancecloud/dan-websocket) | Gradle / Maven |

Both implementations are **wire-compatible**: a TypeScript server can serve Java clients and vice versa.
