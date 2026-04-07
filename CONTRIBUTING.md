# Contributing to dan-websocket

## Development Setup

```bash
git clone https://github.com/justdancecloud/danws_typescript.git
cd danws_typescript
npm install
```

### Run Tests

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
  protocol/     Frame types, codec, serializer, stream-parser
  connection/   BulkQueue, HeartbeatManager, ReconnectEngine
  state/        KeyRegistry, AuthController
tests/
  api/          E2E integration tests
  protocol/     Unit tests for codec, serializer, parser
  connection/   Unit tests for bulk-queue, heartbeat, reconnect
  state/        Unit tests for key-registry, auth-controller
docs/           Architecture and guides
```

## Writing Tests

- Use ports in range `19000-19999` for test servers (check existing tests to avoid conflicts)
- Always clean up servers and clients in `afterEach`
- Use `waitFor(ms)` for timing, `waitUntil(fn)` for condition-based waiting
- E2E tests go in `tests/api/`, unit tests go alongside their module

## Pull Request Process

1. Fork the repository
2. Create a feature branch from `main`
3. Write tests for new functionality
4. Ensure all tests pass: `npx vitest run --exclude tests/api/stress.test.ts`
5. Ensure build succeeds: `npx tsup`
6. Submit a pull request with a clear description

## Code Style

- TypeScript strict mode
- No generics on public API types
- `@internal` JSDoc tag on methods not intended for public use
- Underscore prefix (`_method`) for internal methods
- No unnecessary abstractions — prefer explicit code over clever patterns

## Cross-Language Compatibility

dan-websocket has a Java implementation that must remain wire-compatible. When modifying the protocol:

1. Update `dan-protocol.md` specification first
2. Implement in TypeScript
3. Ensure the Java implementation is updated to match
4. Run E2E tests on both to verify wire compatibility

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
