# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.4.0] - 2026-04-08
### Added
- VarInteger (0x0D): Zigzag + VarInt encoding for integers (1-9 bytes)
- VarDouble (0x0E): Scale + VarInt mantissa for doubles (2-9 bytes)
- VarFloat (0x0F): Float32 fallback variant (decode only in JS)
- PrincipalTX auto-eviction with configurable TTL (default 5min)
- vitest parallel test execution

### Fixed
- ESM import: exports map pointed to .mjs but files were .js
- onReady timing: deferred to microtask ensuring all values received

### Changed
- Numbers auto-detect to VarInteger/VarDouble instead of Float64

## [2.3.1] - 2026-04-08
### Added
- ClientKeyRequest O(1) lookup via reverse keyId index
- Single-pass buildAllFrames() for resync
- Key validation caching
- Topic client keys cached index
- Array shift detection bounded to 50 positions

### Changed
- Heartbeat timeout check interval 1s to 5s

## [2.3.0] - 2026-04-08
### Added
- Reusable shared buffer for numeric serialization
- Single-pass codec batch encoding
- Uint8Array stream parser (replaces Array.push)
- Flatten path string pre-computation
- Client topic key regex replaced with cached lookups
- KeyRegistry.paths cached array

## [2.2.3] - 2026-04-08
### Added
- PrincipalTX auto-eviction after configurable TTL
- State proxy prefix cache with reference identity

## [2.2.2] - 2026-04-08
### Added
- Error throw when no listeners (Node.js EventEmitter pattern)
- freedKeyIds pool capped at 10,000
- crypto.getRandomValues fallback for browsers
- wss:// transport security docs
- CQRS architecture docs

## [2.2.1] - 2026-04-07
### Added
- Protocol v3.4: ServerKeyDelete (0x22), ClientKeyRequest (0x23)
- Incremental key deletion (no full resync)
- Single-key recovery (no full state reset)
- KeyId reuse pool for long-running servers

## [2.2.0] - 2026-04-07
### Added
- maxMessageSize / maxValueSize configurable limits
- Debug logging system
- Comprehensive mode tests (all 4 modes)
- Browser compatibility tests
- SECURITY.md, CONTRIBUTING.md, docs/

## [2.1.5] - 2026-04-06
### Added
- TopicHandle, TopicPayload, EventType for server-side topic API
- TopicClientHandle for client-side topic access
- session.set()/get()/clearKey() backward compat

## [2.1.4] - 2026-04-07
### Fixed
- .d.ts now hides @internal members via stripInternal
- TopicNamespace interface no longer exposes internal callbacks
- EventType.SubscribedEvent typo in README corrected to EventType.SubscribeEvent

### Added
- DanWSError code table in README (15 error codes documented)

## [2.1.3] - 2026-04-07
### Changed
- PrincipalTX and TopicPayload fully migrated to FlatStateManager
- UUID helpers unified (auth-controller exports, server dedup removed)
- _processTopicSync single-pass key classification (no double regex)

### Fixed
- Non-flatten value type change now triggers resync correctly
- Params comparison uses shallowEqual instead of JSON.stringify
- TopicHandle/TopicClientHandle log callback errors instead of empty catch

## [2.1.2] - 2026-04-07
### Changed
- Extract FlatStateManager for Session (eliminates ~130 lines of duplicated set/get/clear)
- Unify isSignalFrame/isKeyRegistrationFrame into types.ts (single source of truth)

### Fixed
- Session._emit logs callback errors instead of silently swallowing
- client.connect logs connection errors for debugging
- client.unsubscribe cleans topicClientHandles (memory leak)
- previousArrays cleared on key deletion (memory leak, all 3 stores)

## [2.1.1] - 2026-04-07
### Changed
- Extract shared array-diff utility (~845 lines removed)
- Remove unused HandshakeController and OfflineQueue

### Fixed
- ReconnectEngine: timer now triggers connect() automatically
- _topicDirty: flush pending topic subscriptions on reconnect
- TopicClientHandle.onUpdate now fires per-flush batch (not per-frame)
- IDENTIFY frame includes protocol version (v3.3), backward-compatible with 16-byte

## [2.1.0] - 2026-04-07
### Added
- Protocol v3.3: SERVER_FLUSH_END (0xFF) batch boundary frame
- Batch-level onUpdate: fires once per BulkQueue flush (~100ms) instead of per-frame

### Changed
- onReceive remains per-frame for fine-grained key-level listeners
- BulkQueue automatically appends SERVER_FLUSH_END at the end of every flush

## [2.0.1] - 2026-04-07
### Fixed
- Redundant full sync: server ignores CLIENT_READY when already in READY state
- Client only sends CLIENT_READY when state !== "ready"
- Heartbeat double-send removed: server no longer echoes heartbeat on receive

## [2.0.0] - 2026-04-06
### Added
- Protocol v3.2: ARRAY_SHIFT_LEFT (0x20) and ARRAY_SHIFT_RIGHT (0x21) frame types
- Auto array diff detection: shift, append, pop patterns detected automatically
- Smart shift detection algorithm: any shift amount supported
- Configurable BulkQueue flush interval (flushIntervalMs server option, default 100ms)

### Changed
- Array shrink without full resync: stale index keys cleaned via .length
- Incremental key registration for Session and TopicPayload (3 frames instead of full resync)
- Value change detection in PrincipalTX and Session setLeaf: unchanged values no longer re-sent
- Principal session index: O(1) lookup instead of O(N) scan
- Key frame caching in PrincipalTX
- Wire path caching in TopicPayload

## [1.0.0] - 2026-04-06
### Added
- Stable release: production-ready
- 4 modes: Broadcast, Principal, Session Topic, Session Principal Topic
- Auto-flatten objects/arrays to binary leaf keys (depth 10, circular ref detection)
- Proxy-based client access (client.data.user.name)
- 4-byte keyId (supports 4B+ keys)
- Topic API: setCallback + setDelayedTask pattern with EventType
- TopicPayload scoped per-topic key-value store
- BulkQueue: 100ms batch flush with ServerValue dedup
- Heartbeat with auto-reconnection (exponential backoff)
- Callback unsubscribe: all on*() return () => void
- Wire-compatible with Java (dan-websocket for Maven)

## [0.5.0] - 2026-04-06
### Added
- Wire format KeyID 2 bytes to 4 bytes (supports 4B+ keys)
- Auto-flatten: set("key", { nested }) expands to dot-path binary keys
- Arrays auto-flatten with .length key, shrink cleans leftover keys
- client.data Proxy for nested object access
- Array iteration on Proxy (forEach, map, filter, for...of)
- Depth limit (10), circular reference detection

### Changed
- **Breaking**: Wire format KeyID 2 bytes to 4 bytes
- **Breaking**: onUpdate callback receives Proxy object instead of { get, keys }

## [0.4.0] - 2026-04-06
### Fixed
- codec.ts decode() DLE handling: decode entire body before parsing header
- Principal data no longer deleted when last session disconnects
- AuthFail FrameType 0x10 to 0x11 (avoid DLE collision)
- TopicPayload keyId: session-level global allocator (no more collision)
- server.close() now closes WebSocket connections

### Added
- StreamParser reused as instance field in client
- Callback unsubscribe: all on*() methods return () => void
- Server debug option for callback error logging

## [0.3.0] - 2026-04-05
### Added
- Topic API: setCallback, setDelayedTask, EventType
- TopicPayload for per-topic scoped data
- TopicClientHandle for client-side topic access
- server.topic.onSubscribe/onUnsubscribe

## [0.2.0] - 2026-04-05
### Added
- 4 modes (broadcast, principal, session_topic, session_principal_topic)
- Topic subscription with params
- Session TTL and expiry

## [0.1.0] - 2026-04-04
### Added
- Initial release: DanProtocol v3.0 binary protocol
- Server and client with heartbeat, reconnection, key-value sync
