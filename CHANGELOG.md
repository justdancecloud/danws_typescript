# Changelog

## 1.0.1 (2026-04-06)
- Fix: Flatten value change detection — unchanged leaf values no longer re-sent
  - `PrincipalTX.setLeaf()`, `Session.setLeaf()` now skip enqueue when value equals existing
  - Reduces unnecessary wire traffic when re-setting flattened objects with partial changes

## 1.0.0 (2026-04-06)
- **Stable release** — production-ready
- 264 tests passing
- 4 modes: Broadcast, Principal, Session Topic, Session Principal Topic
- Auto-flatten objects/arrays to binary leaf keys (depth 10, circular ref detection)
- Proxy-based client access (`client.data.user.name`)
- 4-byte keyId (supports 4B+ keys)
- Topic API: `setCallback` + `setDelayedTask` pattern with EventType
- TopicPayload scoped per-topic key-value store
- Incremental key registration (3 frames vs full reset)
- BulkQueue: 100ms batch flush with ServerValue dedup
- Heartbeat with auto-reconnection (exponential backoff)
- Callback unsubscribe — all `on*()` return `() => void`
- Wire-compatible with Java (dan-websocket for Maven)

## 0.5.1 (2026-04-06)
- Fix: PrincipalTX._buildKeyFrames always sends ServerSync (empty state after clear)
- Fix: TopicPayload flatten triggers resync on entry deletion (array shrink)
- Add: 31 v1-final tests (server options, flatten stress, proxy edge cases, unsubscribe)
- Add: Competitive comparison table in README
- Add: Configuration section with server/client options docs

## 0.5.0 (2026-04-06)
- **Breaking**: Wire format KeyID 2 bytes → 4 bytes (supports 4B+ keys)
- **Breaking**: `onUpdate` callback receives Proxy object instead of `{ get, keys }`
- Add: Auto-flatten — `set("key", { nested })` expands to dot-path binary keys
- Add: Arrays auto-flatten with `.length` key, shrink cleans leftover keys
- Add: `client.data` Proxy for nested object access (`data.user.name`)
- Add: `client.topic(name).data` Proxy for topic data
- Add: Array iteration on Proxy (forEach, map, filter, for...of)
- Depth limit (10), circular reference detection

## 0.4.0 (2026-04-06)
- Fix: `codec.ts` decode() DLE handling — decode entire body before parsing header
- Fix: Principal data no longer deleted when last session disconnects
- Fix: AuthFail FrameType 0x10 → 0x11 (avoid DLE collision)
- Fix: TopicPayload keyId — session-level global allocator (no more collision)
- Fix: `server.close()` now closes WebSocket connections
- Add: StreamParser reused as instance field in client
- Add: Callback unsubscribe — all `on*()` methods return `() => void`
- Add: Server `debug` option for callback error logging
- Remove: HandshakeController, OfflineQueue from public exports (unused)

## 0.3.2 (2026-04-06)
- Fix: Async callback error handling
- Add: 17 edge case tests

## 0.3.1 (2026-04-06)
- Fix: Re-subscribe wire index sync
- Fix: Session flat keyId collision (start at 50001)
- Add: 17 advanced tests

## 0.3.0 (2026-04-05)
- Add: Topic API — `setCallback`, `setDelayedTask`, `EventType`
- Add: `TopicPayload` for per-topic scoped data
- Add: `TopicClientHandle` for client-side topic access
- Add: `server.topic.onSubscribe/onUnsubscribe`

## 0.2.0 (2026-04-05)
- Add: 4 modes (broadcast, principal, session_topic, session_principal_topic)
- Add: Topic subscription with params
- Add: Session TTL and expiry

## 0.1.0 (2026-04-04)
- Initial release: DanProtocol v3.0 binary protocol
- Server and client with heartbeat, reconnection, key-value sync
