# Migration Guide

## 2.3.x → 2.4.0

### No Breaking Changes

v2.4.0 is fully backward-compatible with v2.3.x. All existing APIs work without modification.

### VarNumber Encoding (Automatic)

Numbers are now automatically compressed using variable-length encoding. This happens transparently in the auto-type detector — no code changes required.

**Before (v2.2.x):**
- All integers were encoded as `Float64` (8 bytes)
- All decimals were encoded as `Float64` (8 bytes)

**After (v2.3.0+):**
- Integers use `VarInteger` — zigzag + varint encoding (1-5 bytes typically)
- Decimals use `VarDouble` — scale + varint mantissa (2-4 bytes typically)

| Value | Old size | New size | Savings |
|-------|:---:|:---:|:---:|
| `0` | 8 bytes | 1 byte | 87% |
| `42` | 8 bytes | 1 byte | 87% |
| `1000` | 8 bytes | 2 bytes | 75% |
| `100000` | 8 bytes | 3 bytes | 62% |
| `3.14` | 8 bytes | 3 bytes | 62% |
| `67000.50` | 8 bytes | 4 bytes | 50% |
| `NaN` / `Infinity` | 8 bytes | 9 bytes (fallback) | -12% |

**Impact:** If your data is mostly numbers (dashboards, tickers, game state), expect 50-75% bandwidth reduction without any code changes. Special values (NaN, Infinity, -0) use a 9-byte fallback — slightly larger than before, but these are rare in practice.

**Wire compatibility:** VarNumber types are supported since protocol v3.4. Both TypeScript and Java clients at v2.3.0+ decode them correctly. If you have older clients that haven't been updated, they will fail to decode VarInteger/VarDouble frames. **Update all clients and servers together.**

### ESM Import Fix

If you were importing from `dan-websocket` in an ESM project and getting module resolution errors, this is now fixed. The `exports` map in `package.json` correctly maps both ESM and CJS entry points:

```json
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    },
    "./server": {
      "types": "./dist/server.d.ts",
      "import": "./dist/server.js",
      "require": "./dist/server.cjs"
    }
  }
}
```

No code changes needed — just update to v2.4.0.

### onReady Timing Change

`onReady` is now deferred to the next microtask after `ServerSync` is received. This ensures that all frames in the same WebSocket message batch are processed before `onReady` fires.

**Before (v2.2.x):**
```
ServerSync → onReady fires → remaining ServerValue frames processed
                              ↑ data may be incomplete here
```

**After (v2.3.0+):**
```
ServerSync → remaining frames processed → microtask → onReady fires
                                                       ↑ data is complete
```

**Impact:** If you were accessing data inside `onReady` and sometimes getting `undefined` for values that should exist, this fix resolves that. If you were working around this by using `setTimeout(0)` or similar delays, you can remove those workarounds.

```typescript
// This now reliably has all data:
client.onReady(() => {
  console.log(client.data.user.name);  // Always defined after initial sync
});
```

### PrincipalTX Auto-Eviction

Principal data is now automatically evicted after all sessions disconnect and stay disconnected for `principalEvictionTtl` (default: 5 minutes). Previously, principal data persisted indefinitely.

**If you want to keep the old behavior:**

```typescript
const server = new DanWebSocketServer({
  port: 8080,
  mode: "principal",
  principalEvictionTtl: 0, // Disable auto-eviction — data persists forever
});
```

**If you want faster eviction:**

```typescript
const server = new DanWebSocketServer({
  port: 8080,
  mode: "principal",
  principalEvictionTtl: 60_000, // 1 minute
});
```

**Behavior:** When the last session for a principal disconnects, a timer starts. If a session reconnects before the timer fires, eviction is cancelled. If no sessions reconnect, all principal data (keys, values) is deleted and keyIds are recycled.

### Performance Optimizations

These are internal and require no code changes:

- **Reusable buffers:** Numeric serialization now shares a single `ArrayBuffer`, eliminating 2 of 3 allocations per value.
- **Single-pass encoding:** Frames are encoded in one pass with cached lookups.
- **Parallel test execution:** Tests now run in parallel for faster CI. This doesn't affect your code but may affect your test setup if you were running dan-websocket tests alongside your own.

### Upgrade Steps

1. Update the package:
   ```bash
   npm install dan-websocket@2.4.0
   ```

2. If using principal mode, decide on `principalEvictionTtl`:
   - Default (5 min) is fine for most apps
   - Set `0` to disable if you manage principal lifecycle manually

3. Remove any `onReady` timing workarounds (setTimeout/nextTick)

4. **Update all clients and servers together** — VarNumber encoding requires both sides to be v2.3.0+

5. No API changes, no code modifications needed.

---

## 2.1.x → 2.2.0

### No Breaking Changes

v2.2.0 is a stability release. All v2.1.x APIs remain fully backward-compatible.

### New Defaults

| Option | v2.1.x | v2.2.0 | Impact |
|--------|--------|--------|--------|
| `maxMessageSize` | No limit | 1 MB | Oversized messages rejected. Increase if needed. |
| `maxValueSize` | No limit | 64 KB | `set()` throws if a single serialized value exceeds limit. |

If your application sets large binary values or strings, you may need to increase these limits:

```typescript
const server = new DanWebSocketServer({
  port: 8080,
  mode: "broadcast",
  maxMessageSize: 4_194_304,  // 4MB
  maxValueSize: 1_048_576,    // 1MB
});
```

### New Features

- `server.setDebug(true)` / `client.setDebug(true)` — debug logging for callback errors
- `maxMessageSize` / `maxValueSize` — configurable size limits
- `DanWebSocketClient.shutdownSharedGroup()` (Java only) — clean up shared thread pool

### Bug Fixes

- StreamParser buffer bounded (prevents OOM from malformed frames)
- Server.close() no longer deadlocks when called from Netty thread (Java)
- Principal index properly cleaned on reconnect (Java)
- State Proxy prefix cache rebuilt on every access (prevents stale data)

## 1.x → 2.0.0

### Breaking Changes

1. **Protocol version**: v3.2 → v3.3. Clients and servers must use the same major protocol version.
2. **SERVER_FLUSH_END (0xFF)**: New frame type added. Old clients will not understand this frame.
3. **`onUpdate` behavior changed**: Now fires once per batch (on SERVER_FLUSH_END), not per frame.

### Migration Steps

1. Update both server and client to v2.0.0 simultaneously
2. Replace per-frame rendering logic with `onUpdate` callback:

```typescript
// Before (v1.x) — rendered on every frame
client.onReceive((key, value) => {
  updateUI(key, value);  // called 100x per batch
});

// After (v2.0) — render once per batch
client.onUpdate((state) => {
  renderUI(state);  // called once per ~100ms batch
});
```

3. Array shift optimization is automatic — no code changes needed.

## 0.x → 1.0.0

### Breaking Changes

1. Complete API redesign. See README for current API.
2. Protocol v3.0 — not compatible with 0.x wire format.
