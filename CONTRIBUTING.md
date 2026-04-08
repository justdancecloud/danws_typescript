# Contributing to dan-websocket

## Development Setup

```bash
git clone https://github.com/justdancecloud/danws_typescript.git
cd danws_typescript
npm install
```

**Requirements:**
- Node.js 18+ (LTS recommended)
- npm 9+

### Run Tests

Tests run in parallel using vitest with the `forks` pool for isolation.

```bash
# Protocol conformance tests (excludes stress tests)
npx vitest run --exclude tests/api/stress.test.ts

# Watch mode
npx vitest --exclude tests/api/stress.test.ts

# Stress tests (separate, requires more resources)
npx vitest run tests/api/stress.test.ts
```

### Build

```bash
npx tsup
```

Output goes to `dist/` with three entry points: `index`, `server`, `protocol`.

## Project Structure

```
src/
  api/          Server, Client, Session, TopicHandle, FlatStateManager
  protocol/     Frame types, codec, serializer, stream-parser, VarNumber encoding
  connection/   BulkQueue, HeartbeatManager, ReconnectEngine
  state/        KeyRegistry, AuthController, StateProxy
tests/
  api/          E2E integration tests (all 4 modes, reconnection, browser compat)
  protocol/     Unit tests for codec, serializer, parser, VarNumber
  connection/   Unit tests for bulk-queue, heartbeat, reconnect
  state/        Unit tests for key-registry, auth-controller
docs/           Architecture diagrams and guides
```

Key files:
- `src/protocol/types.ts` -- DataType enum, FrameType enum, control characters
- `src/protocol/codec.ts` -- Frame encoding/decoding with DLE byte-stuffing
- `src/protocol/serializer.ts` -- Value serialization (including VarInteger/VarDouble/VarFloat)
- `src/api/server.ts` -- DanWebSocketServer main entry point
- `src/api/client.ts` -- DanWebSocketClient main entry point
- `dan-protocol.md` -- Full binary protocol specification

## Writing Tests

- Use ports in range `19000-19999` for test servers (check existing tests to avoid conflicts)
- Always clean up servers and clients in `afterEach`
- Use `waitFor(ms)` for timing, `waitUntil(fn)` for condition-based waiting
- E2E tests go in `tests/api/`, unit tests go alongside their module
- Stress tests (StressTest, TenKTest, stress.test.ts) are excluded from normal test runs

## Pull Request Process

1. Fork the repository
2. Create a feature branch from `main`
3. Write tests for new functionality
4. Ensure all tests pass: `npx vitest run --exclude tests/api/stress.test.ts`
5. Ensure build succeeds: `npx tsup`
6. Update `dan-protocol.md` if the change affects the wire protocol
7. Update `CHANGELOG.md` with your changes
8. Submit a pull request with a clear description

## Code Style

- TypeScript strict mode
- **English comments only** -- all code comments, JSDoc, and documentation must be in English
- No generics on public API types
- `@internal` JSDoc tag on methods not intended for public use (stripped from .d.ts via `stripInternal`)
- Underscore prefix (`_method`) for internal methods
- No unnecessary abstractions -- prefer explicit code over clever patterns
- Reuse shared buffers for numeric serialization where possible
- Cache computed values (key validation, flatten paths, regex results)

## Cross-Language Compatibility

dan-websocket has a Java implementation (`io.github.justdancecloud:dan-websocket` on Maven Central) that must remain wire-compatible. When modifying the protocol:

1. Update `dan-protocol.md` specification first
2. Implement in TypeScript
3. Ensure the Java implementation (`danws_java`) is updated to match
4. Run E2E tests on both to verify wire compatibility
5. Both libraries must support encoding and decoding of all 16 data types

This includes VarInteger, VarDouble, and VarFloat encoding -- both implementations must produce identical wire bytes for the same input values.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
