# Migration Guide

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
