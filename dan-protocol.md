# DanProtocol v3.5 Specification

> April 2026 | Real-Time State Synchronization with Auto-Flatten, Array Operations & Variable-Length Encoding

---

## 1. What is DanProtocol?

DanProtocol is a **lightweight binary protocol** designed for pushing real-time state from a server to connected clients. It runs over WebSocket, TCP, serial, or any byte-stream transport.

### Key Design Decisions

| Decision | Why |
|----------|-----|
| **Binary wire format** | Minimal bandwidth. A boolean update is ~13 bytes total (vs ~30+ bytes for JSON). |
| **DLE-based framing** | Self-synchronizing frames without length prefixes. Robust on unreliable streams. |
| **Auto-typed** | No schema declaration needed. 16 data types detected from values. |
| **4-byte KeyID** | Supports 4B+ unique keys for auto-flatten at scale. |
| **Auto-flatten** | Objects/arrays expand into dot-path leaf keys at API layer. Only changed fields go on wire. |
| **Principal-based** | State is per-authenticated-user, not per-connection. Multiple devices share one state. |
| **VarNumber encoding** | Integers and doubles use variable-length encoding (1-9 bytes) instead of fixed 8 bytes. |

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

Signal frames MUST set DataType to `0x00` (Null). Receivers SHOULD ignore this field for signal frames.

### 2.3 Heartbeat (not a frame)

```
+---------+---------+
| DLE     | ENQ     |
| 0x10    | 0x05    |
+---------+---------+
```

Sent every 10 seconds by both sides. If not received within 15 seconds, the connection is considered dead.

- **Server behavior**: starts heartbeat timer on connection open; resets on any received message.
- **Client behavior**: starts heartbeat timer after IDENTIFY; resets on any received message.
- **Timeout**: if no heartbeat or data received within 15 seconds, the side closes the connection.
- **Check interval**: the heartbeat timeout is checked every 5 seconds (not continuously).

---

## 3. Frame Types

### 3.1 Server to Client -- Data

| Code | Name | Payload | Description |
|------|------|---------|-------------|
| `0x00` | ServerKeyRegistration | UTF-8 keyPath | Registers a new keyId-to-path mapping |
| `0x01` | ServerValue | Typed value | Sends a value update for a registered keyId |

### 3.2 Client to Server -- Data (Topic Mode)

| Code | Name | Payload | Description |
|------|------|---------|-------------|
| `0x02` | ClientKeyRegistration | UTF-8 keyPath | Client registers a key (topic subscriptions) |
| `0x03` | ClientValue | Typed value | Client sends a value (topic name/params) |

### 3.3 Handshake / Sync

| Code | Name | Direction | Payload | Description |
|------|------|-----------|---------|-------------|
| `0x04` | ServerSync | S->C | -- | Server has finished sending key registrations |
| `0x05` | ClientReady | C->S | -- | Client is ready to receive values |
| `0x06` | ClientSync | C->S | -- | Client has finished sending topic subscriptions |
| `0x07` | ServerReady | S->C | -- | Server acknowledges client sync |

### 3.4 Control

| Code | Name | Direction | Payload | Description |
|------|------|-----------|---------|-------------|
| `0x08` | Error | Both | UTF-8 message | Error with human-readable description |
| `0x09` | ServerReset | S->C | -- | Server instructs client to clear all state |
| `0x0A` | ClientResyncReq | C->S | -- | Client requests full state resynchronization |
| `0x0B` | ClientReset | C->S | -- | Client clears its topic subscription state |
| `0x0C` | ServerResyncReq | S->C | -- | Server instructs client to re-send subscriptions |

### 3.5 Authentication

| Code | Name | Direction | Payload | Description |
|------|------|-----------|---------|-------------|
| `0x0D` | Identify | C->S | 16-byte UUIDv7 (+ optional 2-byte version) | Client identifies itself |
| `0x0E` | Auth | C->S | UTF-8 token | Client sends auth token |
| `0x0F` | AuthOk | S->C | -- | Server confirms authentication |
| `0x11` | AuthFail | S->C | UTF-8 reason | Server rejects authentication |

**IDENTIFY (0x0D) Payload Format:**

Payload: 16-byte UUIDv7 + optional 2-byte protocol version (major, minor). Servers accepting 18-byte payload extract version; 16-byte payload is treated as version 0.0.

> **Note**: `0x10` is reserved (DLE control character). AuthFail uses `0x11` to avoid collision.

### 3.6 Array Operations

| Code | Name | Direction | Payload | Description |
|------|------|-----------|---------|-------------|
| `0x20` | ArrayShiftLeft | S->C | Int32 shift count | Shift array elements left by N |
| `0x21` | ArrayShiftRight | S->C | Int32 shift count | Shift array elements right by N |

**ARRAY_SHIFT_LEFT (0x20):**

Used to optimize array left-shift patterns (e.g., sliding window: `[1,2,3,4,5]` -> `[2,3,4,5,6]`). Instead of re-sending all shifted element values, the server sends a single ARRAY_SHIFT_LEFT frame.

- **KeyID**: keyId of `{arrayKey}.length` (identifies which array)
- **DataType**: Int32 (0x06)
- **Payload**: shift count as int32 (4 bytes) -- how many elements shifted off the front

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
- **Payload**: shift count as int32 (4 bytes) -- how many positions to shift right

**Client action on receiving ARRAY_SHIFT_RIGHT(keyId=lengthKeyId, payload=k):**

1. Look up the path for `lengthKeyId` (e.g., `data.length`)
2. Derive the array prefix (e.g., `data`)
3. Read current length from store
4. For `i` from `length - 1` down to `0`: copy value at `{prefix}.{i}` to `{prefix}.{i+k}`
5. Do NOT update length (server sends new head elements + length update separately)
6. Fire callbacks for `{prefix}.length`

**Server-side array diff detection (Smart Detection Algorithm):**

When `set(key, array)` is called and a previous array exists for that key, the server compares old and new arrays to detect shift patterns. The algorithm supports **any shift amount** (bounded to 50 positions for performance).

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

**Wire example -- left shift by 1 on array "scores" (length keyId=0x00000005):**

```
10 02 20 00 00 00 05 06 00 00 00 01 10 03
|  |  |  |--------|  |  |--------| |  |
|  |  |    KeyID   |  |  payload   DLE ETX
|  |  FrameType   DataType=Int32
DLE STX  =0x20     =0x06         shiftCount=1
```

**Wire example -- right shift by 1 on array "scores" (length keyId=0x00000005):**

```
10 02 21 00 00 00 05 06 00 00 00 01 10 03
|  |  |  |--------|  |  |--------| |  |
|  |  |    KeyID   |  |  payload   DLE ETX
|  |  FrameType   DataType=Int32
DLE STX  =0x21     =0x06         shiftCount=1
```

### 3.7 Key Lifecycle

| Code | Name | Direction | Payload | Description |
|------|------|-----------|---------|-------------|
| `0x22` | ServerKeyDelete | S->C | Signal (no payload) | Incremental key deletion |
| `0x23` | ClientKeyRequest | C->S | Signal (no payload) | Single-key recovery request |

**ServerKeyDelete (0x22):**

Incremental key deletion. The server sends this instead of a full ServerReset+resync when individual keys are removed.

- **KeyID**: the keyId being deleted
- **DataType**: Null (0x00) -- signal frame
- **Payload**: none

**Client action on receiving ServerKeyDelete(keyId):**
1. Remove keyId from key registry
2. Remove keyId from value store
3. Fire onReceive(path, undefined) to notify listeners of deletion

**Use cases:**
- `server.clear("user")` -- sends ServerKeyDelete for each flattened sub-key
- Type change (e.g., number to string) -- sends ServerKeyDelete(old keyId) + ServerKeyRegistration(new keyId) + ServerSync + ServerValue

**KeyId reuse:** Deleted keyIds are added to a reuse pool (`freedKeyIds`, capped at 10,000 entries). New key registrations draw from this pool first before allocating new IDs, preventing keyId exhaustion on long-running servers.

**ClientKeyRequest (0x23):**

Single-key recovery. The client sends this when it receives a ServerValue for an unknown keyId, instead of requesting a full state resync.

- **KeyID**: the keyId the client needs information about
- **DataType**: Null (0x00) -- signal frame
- **Payload**: none

**Server action on receiving ClientKeyRequest(keyId):**
1. Find the keyId in current state (principal TX, session flat state, or topic payloads)
2. Send: ServerKeyRegistration(keyId, path, type) + ServerSync + ServerValue(keyId, value)
3. If keyId not found, no response (client will timeout and may request full resync)

**Client behavior for unknown keyId:**
1. Receive ServerValue(keyId=X) but keyId X is not in registry
2. Send ClientKeyRequest(keyId=X)
3. Buffer the value in pendingValues map
4. When ServerKeyRegistration arrives for keyId X, apply the buffered value immediately

**Client uses O(1) reverse keyId index** for looking up key requests, avoiding linear scans.

### 3.8 Batch Boundary

| Code | Name | Direction | Payload | Description |
|------|------|-----------|---------|-------------|
| `0xFF` | ServerFlushEnd | S->C | -- | End of batch marker |

**SERVER_FLUSH_END (0xFF):**

Sent automatically at the end of every BulkQueue flush batch. This signal tells the client that all frames in this batch have been delivered, and the client's state is now consistent with the server at this point in time.

- **Purpose**: Prevents render storms. Without this, `onReceive` fires per-frame causing N re-renders per batch. With `ServerFlushEnd`, the client fires `onUpdate` exactly once per batch.
- **Client behavior**:
  - `onReceive(key, value)` -- fires per individual `ServerValue` frame (fine-grained, per-key)
  - `onUpdate(state)` -- fires once when `ServerFlushEnd` is received (batch-level, for rendering)
- **Timing**: Appended to every BulkQueue flush (default every 100ms). Initial sync values also go through BulkQueue, so the first `onUpdate` fires after the initial data is fully loaded.

---

## 4. Data Types

Types are auto-detected from application values. No explicit declaration needed.

### 4.1 Complete Data Type Table

| Code | Type | Size | JS / Java Type | Description |
|------|------|------|----------------|-------------|
| `0x00` | Null | 0 | `null` / `null` | Absence of value |
| `0x01` | Bool | 1 | `boolean` / `Boolean` | `0x00` = false, `0x01` = true |
| `0x02` | Uint8 | 1 | -- | Unsigned 8-bit integer (0-255) |
| `0x03` | Uint16 | 2 | -- | Unsigned 16-bit integer (big-endian) |
| `0x04` | Uint32 | 4 | -- / `Integer` | Unsigned 32-bit integer (big-endian) |
| `0x05` | Uint64 | 8 | `bigint` / `Long` | Unsigned 64-bit integer (big-endian) |
| `0x06` | Int32 | 4 | -- / `Integer` | Signed 32-bit integer (big-endian) |
| `0x07` | Int64 | 8 | `bigint` / `Long` | Signed 64-bit integer (big-endian) |
| `0x08` | Float32 | 4 | -- / `Float` | IEEE 754 single-precision (big-endian) |
| `0x09` | Float64 | 8 | `number` / `Double` | IEEE 754 double-precision (big-endian) |
| `0x0A` | String | variable | `string` / `String` | UTF-8 encoded, length = payload size |
| `0x0B` | Binary | variable | `Uint8Array` / `byte[]` | Raw bytes, length = payload size |
| `0x0C` | Timestamp | 8 | `Date` / `Date` | Milliseconds since Unix epoch as Int64 |
| `0x0D` | VarInteger | variable | `number` (integer) / `Integer`, `Long` | Zigzag + VarInt encoded integer (1-9 bytes) |
| `0x0E` | VarDouble | variable | `number` (non-integer) / `Double` | Scale + VarInt mantissa (2-9 bytes) |
| `0x0F` | VarFloat | variable | -- / `Float` (decode only in JS) | Float32 fallback variant |

### 4.2 VarInteger Encoding (0x0D)

A compact variable-length encoding for integer values using zigzag + unsigned VarInt. Added in protocol v3.5.

**Zigzag encoding:** Maps signed integers to unsigned integers so that small-magnitude values (positive or negative) use fewer bytes:
- Encode: `(n >= 0) ? n * 2 : (-n) * 2 - 1`
- Decode: `(zigzag & 1) ? -floor(zigzag / 2) - 1 : floor(zigzag / 2)`
- Mapping: `0->0, -1->1, 1->2, -2->3, 2->4, ...`

**VarInt encoding** (protobuf-style unsigned):
- 7 bits per byte, MSB (most significant bit) = continuation bit
- If MSB = 1, more bytes follow. If MSB = 0, this is the last byte.
- Byte pattern:
  - `0-127`: 1 byte `[0XXXXXXX]`
  - `128-16383`: 2 bytes `[1XXXXXXX] [0XXXXXXX]`
  - `16384-2097151`: 3 bytes `[1XXXXXXX] [1XXXXXXX] [0XXXXXXX]`
  - Up to 9 bytes for 64-bit values.

**Examples:**

| Value | Zigzag | VarInt Bytes | Total Size | Description |
|-------|--------|-------------|------------|-------------|
| `0` | 0 | `00` | 1 byte | Minimum encoding |
| `1` | 2 | `02` | 1 byte | Small positive |
| `-1` | 1 | `01` | 1 byte | Small negative |
| `42` | 84 | `54` | 1 byte | Fits in 7 bits after zigzag |
| `-42` | 83 | `53` | 1 byte | Fits in 7 bits after zigzag |
| `63` | 126 | `7E` | 1 byte | Largest 1-byte positive |
| `64` | 128 | `80 01` | 2 bytes | Smallest 2-byte positive |
| `300` | 600 | `D8 04` | 2 bytes | 2-byte encoding |
| `100000` | 200000 | `C0 9A 0C` | 3 bytes | 3-byte encoding |

**Size comparison vs fixed-width:**

| Value Range | VarInteger | Int32 | Int64 | Savings |
|-------------|-----------|-------|-------|---------|
| -64 to 63 | 1 byte | 4 bytes | 8 bytes | 75-87% |
| -8192 to 8191 | 2 bytes | 4 bytes | 8 bytes | 50-75% |
| Most app values | 1-3 bytes | 4 bytes | 8 bytes | significant |

### 4.3 VarDouble Encoding (0x0E)

A compact variable-length encoding for non-integer numbers using scale + mantissa. Added in protocol v3.5.

**First byte layout: `[FSSS SSSS]`**

- **F** (bit 7) = fallback flag. When set (`0x80`), the next 8 bytes are a raw Float64 (big-endian IEEE 754). Total: 9 bytes.
- **SSSSSSS** (bits 6-0) = sign + scale:
  - `0~63`: positive number, scale = value. Followed by unsigned VarInt mantissa.
  - `64~127`: negative number, scale = value - 64. Followed by unsigned VarInt mantissa.

**VarInt mantissa** (protobuf-style unsigned):
- 7 bits per byte, MSB = continuation bit
- `0-127`: 1 byte `[0XXXXXXX]`
- `128-16383`: 2 bytes `[1XXXXXXX] [0XXXXXXX]`
- Up to 8 bytes for large mantissas.

**Reconstructing the number:** `(-1 if negative) * mantissa / 10^scale`

**Fallback mode (F=1):** Used when the value cannot be represented as scale + mantissa:
- NaN, Infinity, -Infinity, -0
- Scientific notation values
- Scale > 63
- Numbers whose decimal mantissa exceeds `Number.MAX_SAFE_INTEGER`

Byte `0x80` followed by 8-byte IEEE 754 Float64 (big-endian). Total: 9 bytes.

**Examples:**

| Value | Bytes (hex) | Size | Description |
|-------|-------------|------|-------------|
| `3.14` | `02 BA 02` | 3 bytes | scale=2, positive, mantissa=314 |
| `-7.5` | `41 4B` | 2 bytes | scale=1, negative, mantissa=75 |
| `0.001` | `03 01` | 2 bytes | scale=3, positive, mantissa=1 |
| `99.99` | `02 8F 4E` | 3 bytes | scale=2, positive, mantissa=9999 |
| `Math.PI` | `80 [8 bytes]` | 9 bytes | fallback Float64 (irrational) |
| `NaN` | `80 [8 bytes]` | 9 bytes | fallback Float64 |
| `Infinity` | `80 [8 bytes]` | 9 bytes | fallback Float64 |

**Size comparison vs fixed-width Float64:**

| Value Type | VarDouble | Float64 | Savings |
|------------|----------|---------|---------|
| `0.5`, `1.5` | 2 bytes | 8 bytes | 75% |
| `3.14`, `99.99` | 3 bytes | 8 bytes | 62% |
| Irrational numbers | 9 bytes | 8 bytes | -12% (1 byte overhead) |

### 4.4 VarFloat Encoding (0x0F)

Same encoding as VarDouble, except the fallback uses 4-byte Float32 instead of 8-byte Float64.

- **Fallback (F=1):** Byte `0x80` followed by 4-byte IEEE 754 Float32 (big-endian). Total: 5 bytes.
- **Non-fallback:** Identical to VarDouble (scale + mantissa). Bytes are the same.

JS/TS never auto-detects as VarFloat (JavaScript has no float32 distinction), but must be able to **decode** it for cross-language compatibility with Java `Float` values. Java auto-detects `Float` as VarFloat.

### 4.5 Auto-Detection Rules

The protocol automatically selects the wire type based on the value's runtime type. No explicit type declarations are needed.

| Value | Wire Type | Rationale |
|-------|-----------|-----------|
| `null` | Null (0x00) | Absence of value |
| `true` / `false` | Bool (0x01) | Boolean literal |
| JS `number` (integer) / Java `Integer` | VarInteger (0x0D) | Variable-length saves bytes for typical values |
| JS `number` (non-integer) / Java `Double` | VarDouble (0x0E) | Variable-length for decimal numbers |
| Java `Float` | VarFloat (0x0F) | Float32 fallback variant |
| JS `bigint` >= 0 / Java `Long` >= 0 | Uint64 (0x05) | Fixed 8 bytes for large unsigned values |
| JS `bigint` < 0 / Java `Long` < 0 | Int64 (0x07) | Fixed 8 bytes for large signed values |
| `string` / `String` | String (0x0A) | UTF-8 encoded |
| `Uint8Array` / `byte[]` | Binary (0x0B) | Raw byte payload |
| `Date` | Timestamp (0x0C) | Milliseconds since Unix epoch |
| `{ ... }` / `[...]` (object/array) | **Auto-flatten** | API layer expands to leaf keys (not a wire type) |

> **Note**: Prior to v3.5, integers used Int32/Uint32 and non-integers used Float64. Since v3.5, VarInteger and VarDouble are the defaults, providing better compression for typical application values.

---

## 5. DLE Byte-Stuffing

DLE (Data Link Escape, `0x10`) is used as a framing character. Since `0x10` has special meaning, any occurrence of `0x10` within the frame body must be escaped.

### Escaping Rules

| Wire Bytes | Meaning |
|------------|---------|
| `0x10 0x02` | Frame start (DLE STX) |
| `0x10 0x03` | Frame end (DLE ETX) |
| `0x10 0x05` | Heartbeat (DLE ENQ) |
| `0x10 0x10` | Literal `0x10` byte in data (escaped) |
| `0x10 [other]` | Protocol error -- discard and resync |

### How It Works

**Encoding (sender):** Scan the frame body (FrameType + KeyID + DataType + Payload). For every byte that equals `0x10`, emit `0x10 0x10` instead of `0x10`.

**Decoding (receiver):** Scan between DLE STX and DLE ETX. When `0x10` is encountered:
- If followed by `0x10`: consume both bytes, output one `0x10` byte.
- If followed by `0x03`: this is the frame end marker.
- Any other sequence after `0x10` is a protocol error.

**Example:** KeyID `0x00000010` contains a DLE byte. On the wire:
```
10 02 01 00 00 00 10 10 0a ... 10 03
              ^^^^^^^^^ 0x10 in KeyID escaped to 0x10 0x10
```

The entire frame body (FrameType + KeyID + DataType + Payload) is DLE-escaped. The DLE STX and DLE ETX delimiters are NOT escaped.

---

## 6. Auto-Flatten (API Layer)

Objects and arrays are expanded into dot-path leaf keys before going on the wire. This is handled at the API layer, not the protocol layer -- the wire only carries primitive leaf values.

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
- Flatten path strings are pre-computed and cached for performance

### Topic Mode Wire Prefix

In topic modes, each topic's payload keys are prefixed with `t.<index>.`:

```
topic "board" (index=0): t.0.items.length, t.0.items.0.title, ...
topic "chart" (index=1): t.1.value, t.1.timestamp, ...
```

Client-to-Server topic subscriptions use `topic.<index>.name` and `topic.<index>.param.<key>` encoding.

---

## 7. Connection Lifecycle

### 7.1 Handshake Sequence (No Auth)

```
Client                         Server
  |                               |
  |-- IDENTIFY (UUIDv7) -------->|  Create session
  |                               |
  |<-- Key Reg (key1, ...) ------|  Register keys
  |<-- Key Reg (key2, ...) ------|
  |<-- ServerSync ---------------|  "Key registration complete"
  |                               |
  |-- ClientReady --------------->|  "Ready to receive values"
  |                               |
  |<-- Value (key1 = 23.5) ------|  Full state sync
  |<-- Value (key2 = "hello") ---|
  |<-- ServerFlushEnd ------------|  "Batch complete"
  |                               |
  |<-- Value (key1 = 24.1) ------|  Live updates...
  |<-- ServerFlushEnd ------------|
```

### 7.2 Handshake Sequence (With Auth)

```
Client                         Server
  |                               |
  |-- IDENTIFY (UUIDv7) -------->|
  |-- AUTH (token) ------------->|  verify + determine principal
  |<-- AuthOk -------------------|  bind to principal
  |                               |
  |<-- Key Reg ... --------------|
  |<-- ServerSync ---------------|
  |-- ClientReady --------------->|
  |<-- Values ... ---------------|
  |<-- ServerFlushEnd ------------|
```

If authentication fails, the server sends `AuthFail` with a reason string and closes the connection.

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
  |<-- ServerSync ---------------|
  |-- ClientReady --------------->|
  |<-- Values ... ---------------|
  |<-- ServerFlushEnd ------------|
```

### 7.4 Full State Recovery (Resync)

If the client's state is inconsistent, it requests a full resynchronization:

```
Client                         Server
  |-- ClientResyncReq ---------->|
  |<-- ServerReset --------------|
  |<-- Key Reg (all) ------------|
  |<-- ServerSync ---------------|
  |-- ClientReady --------------->|
  |<-- Values (all) -------------|
  |<-- ServerFlushEnd ------------|
```

### 7.5 Single-Key Recovery

If the client receives a value for an unknown keyId, it requests only that key (instead of full resync):

```
Client                         Server
  |<-- ServerValue(keyId=X) -----|  Client doesn't know keyId X
  |-- ClientKeyRequest(keyId=X)->|  Request info for keyId X
  |<-- KeyReg(keyId=X, path) ----|  Server sends key info
  |<-- ServerSync ---------------|
  |<-- ServerValue(keyId=X) -----|  Server re-sends value
```

### 7.6 onReady Timing

The client `onReady` callback is deferred to a microtask after `ClientReady` processing, ensuring all initial values have been received and applied before user code executes.

---

## 8. Heartbeat Mechanism

### Wire Format

The heartbeat is a 2-byte sequence, NOT a framed message:

```
+---------+---------+
| DLE     | ENQ     |
| 0x10    | 0x05    |
+---------+---------+
```

### Timing

| Parameter | Value |
|-----------|-------|
| Send interval | 10 seconds |
| Timeout threshold | 15 seconds |
| Timeout check interval | 5 seconds |

### Behavior

- Both client and server send heartbeats every 10 seconds.
- Any received message (heartbeat or data frame) resets the timeout timer.
- If no message is received within 15 seconds, the connection is considered dead and is closed.
- The timeout check runs every 5 seconds (not continuously) to reduce overhead.
- On heartbeat timeout, the client triggers its reconnection logic (if enabled).

---

## 9. Topic Sync Protocol

Topic sync enables clients to subscribe to server-defined topics with parameters.

### Topic Subscription Encoding

Client sends topic subscriptions as flattened key-value pairs:

```
topic.0.name = "board"          // Topic name
topic.0.param.roomId = "abc"    // Topic parameter
topic.1.name = "chat"           // Second topic
topic.1.param.channel = "general"
```

### Topic Sync Flow

1. **Client sends ClientReset** -- clears server's record of client subscriptions
2. **Client registers keys** -- sends ClientKeyRegistration for each topic name/param path
3. **Client sends values** -- sends ClientValue with topic names and parameter values
4. **Client sends ClientSync** -- signals subscription list is complete
5. **Server processes diff** -- compares new subscriptions against previous, triggers subscribe/unsubscribe callbacks
6. **Server responds with state** -- sends ServerReset + key registrations + ServerSync + values for all subscribed topics

### Topic Wire Prefix

Server-to-client topic data uses `t.<index>.` prefix:
- `t.0.title` -- first topic's title field
- `t.1.items.0.name` -- second topic's nested array item

This prefix is stripped by the client SDK before exposing data to application code.

---

## 10. Batch Framing

Multiple frames can be concatenated in one transport message:

```
[DLE STX ... DLE ETX][DLE STX ... DLE ETX][DLE STX ... DLE ETX]
```

The BulkQueue batches frames every **100ms** (configurable via `flushIntervalMs`) and sends them as one message. Value frames for the same key are **deduplicated** within the window (only the latest value is sent). The batch is built using a single-pass `buildAllFrames()` for resync operations.

---

## 11. KeyPath Convention

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
- Key validation results are cached for performance

---

## 12. Wire Examples (4-byte KeyID)

### Bool value `true` for KeyID 0x00000001

```
10 02 01 00 00 00 01 01 01 10 03
|  |  |  |--------|  |  |  |  |
|  |  |    KeyID   |  |  DLE ETX
|  |  FrameType   DataType
DLE STX  =0x01    =0x01(bool)  payload: 0x01=true
```

### Signal frame (ServerSync, KeyID=0)

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

### VarInteger value `42` for KeyID 0x00000003

```
10 02 01 00 00 00 03 0d 54 10 03
|  |  |  |--------|  |  |  |  |
|  |  |    KeyID   |  |  DLE ETX
|  |  FrameType   DataType
DLE STX  =0x01    =0x0D(VarInteger)  payload: 0x54 (zigzag 84)
```

### VarDouble value `3.14` for KeyID 0x00000004

```
10 02 01 00 00 00 04 0e 02 ba 02 10 03
|  |  |  |--------|  |  |------| |  |
|  |  |    KeyID   |  | payload  DLE ETX
|  |  FrameType   DataType
DLE STX  =0x01    =0x0E(VarDouble)  scale=2, mantissa=314
```

---

## 13. Implementations

| Language | Package | Install |
|----------|---------|---------|
| TypeScript | [`dan-websocket`](https://www.npmjs.com/package/dan-websocket) | `npm install dan-websocket` |
| Java | [`io.github.justdancecloud:dan-websocket`](https://central.sonatype.com/artifact/io.github.justdancecloud/dan-websocket) | Gradle / Maven |

Both implementations are **wire-compatible**: a TypeScript server can serve Java clients and vice versa. Protocol changes require updates to both implementations simultaneously.
