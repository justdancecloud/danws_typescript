# Changelog

## 2.1.6 (2026-04-07)
- README: detailed mode documentation with complete server + client examples for all 4 modes
- README: auth flow, topic lifecycle, multi-device sync, params change explained

## 2.1.5 (2026-04-07)
- Add: `maxMessageSize` option (default 1MB) — limits incoming WebSocket message size via ws maxPayload
- Add: `maxValueSize` option (default 64KB) — throws VALUE_TOO_LARGE if serialized value exceeds limit
- Size limits propagate to PrincipalTX, Session, TopicPayload via FlatStateCallbacks
- README rewritten: cleaner structure, comparison table, mode examples

## 2.1.4 (2026-04-07)
- Fix: `.d.ts` now hides `@internal` members via `stripInternal` (TopicPayload, TopicHandle, Session internals)
- Fix: `TopicNamespace` interface no longer exposes `_onSubscribeCbs`/`_onUnsubscribeCbs` in type definitions
- Fix: `EventType.SubscribedEvent` typo in README → `EventType.SubscribeEvent`
- Add: DanWSError code table in README (15 error codes documented)
- Fix: test badge count updated (265 tests)

## 2.1.3 (2026-04-07)
- Refactor: PrincipalTX and TopicPayload fully migrated to FlatStateManager
- Fix: non-flatten value type change now triggers resync correctly
- Refactor: UUID helpers unified (auth-controller exports, server dedup removed)
- Refactor: _processTopicSync single-pass key classification (no double regex)
- Fix: params comparison uses shallowEqual instead of JSON.stringify
- Fix: TopicHandle/TopicClientHandle log callback errors instead of empty catch

## 2.1.2 (2026-04-07)
- Refactor: extract FlatStateManager for Session (eliminates ~130 lines of duplicated set/get/clear)
- Refactor: unify isSignalFrame/isKeyRegistrationFrame into types.ts (single source of truth)
- Fix: Session._emit logs callback errors instead of silently swallowing
- Fix: client.connect logs connection errors for debugging
- Fix: client.unsubscribe cleans topicClientHandles (memory leak)
- Fix: previousArrays cleared on key deletion (memory leak, all 3 stores)
- Rename: dan-protocol-3.0.md → dan-protocol.md

## 2.1.1 (2026-04-07)
- Refactor: extract shared array-diff utility (~845 lines removed)
- Remove unused HandshakeController and OfflineQueue
- Fix ReconnectEngine: timer now triggers connect() automatically
- Fix `_topicDirty`: flush pending topic subscriptions on reconnect
- TopicClientHandle.onUpdate now fires per-flush batch (not per-frame)
- IDENTIFY frame includes protocol version (v3.3), backward-compatible with 16-byte

## 2.1.0 (2026-04-07)
- **Protocol v3.3**: SERVER_FLUSH_END (0xFF) batch boundary frame
- **Batch-level `onUpdate`**: fires once per BulkQueue flush (~100ms) instead of per-frame — prevents render storms
- `onReceive` remains per-frame for fine-grained key-level listeners
- BulkQueue automatically appends SERVER_FLUSH_END at the end of every flush
- Protocol document updated to v3.3

## 2.0.1 (2026-04-07)
- Fix: Redundant full sync — server ignores CLIENT_READY when already in READY state
- Fix: Client only sends CLIENT_READY when state !== "ready" (prevents periodic full transmission)
- Fix: Heartbeat double-send removed — server no longer echoes heartbeat on receive
- Add: Frame count verification in README with actual E2E test results

## 2.0.0 (2026-04-06)
- **Protocol v3.2**: ARRAY_SHIFT_LEFT (0x20) and ARRAY_SHIFT_RIGHT (0x21) frame types
- **Auto array diff detection**: shift, append, pop patterns detected automatically
- **Smart shift detection algorithm**: no k=1..5 limit, any shift amount supported
- **Array shrink without full resync**: stale index keys cleaned via .length, client uses `.length`
- **Incremental key registration** for Session and TopicPayload (3 frames instead of full resync)
- **Value change detection** in PrincipalTX and Session setLeaf — unchanged values no longer re-sent
- **Principal session index**: O(1) lookup instead of O(N) scan on every value set
- **Key frame caching**: PrincipalTX avoids rebuilding key frames on every resync
- **Wire path caching**: TopicPayload avoids string allocation on every buildKeyFrames
- **Configurable BulkQueue flush interval** (`flushIntervalMs` server option, default 100ms)
- 286 tests passing (22 new array sync tests)

## 1.0.3 (2026-04-07)
- Perf: Incremental key registration for Session and TopicPayload (3 frames instead of full resync)
- Add: BigDecimal → Float64, BigInteger → Int64 (or String if overflow) auto-detection (Java)
- Add: Short → Int32, Byte → Uint8 auto-detection (Java)

## 1.0.2 (2026-04-07)
- Perf: Principal session index — O(1) lookup instead of O(N) scan on every value set
- Perf: PrincipalTX key frame caching — avoid rebuilding on every resync
- Perf: TopicPayload wire path caching — avoid string allocation on every buildKeyFrames
- Add: Configurable BulkQueue flush interval (`flushIntervalMs` server option, default 100ms)

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
