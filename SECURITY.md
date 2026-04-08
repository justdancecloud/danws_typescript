# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability, please report it privately:

- **GitHub Issues:** https://github.com/justdancecloud/danws_typescript/issues (preferred)
- **GitHub Issues:** For non-sensitive issues, open an issue at https://github.com/justdancecloud/danws_typescript/issues

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact

We will respond within 48 hours and aim to release a fix within 7 days for critical issues.

## Security Design

### Message Size Limits

dan-websocket enforces size limits at two levels to prevent memory exhaustion:

| Level | Option | Default | Protection |
|-------|--------|---------|------------|
| WebSocket message | `maxMessageSize` | 1 MB | Rejects oversized incoming messages before parsing |
| Individual value | `maxValueSize` | 64 KB | Throws `VALUE_TOO_LARGE` on `set()` if serialized value exceeds limit |
| StreamParser buffer | `maxMessageSize` | 1 MB | Aborts frame parsing if buffer grows beyond limit |

```typescript
const server = new DanWebSocketServer({
  port: 8080,
  mode: "broadcast",
  maxMessageSize: 2_097_152,  // 2MB
  maxValueSize: 131_072,      // 128KB
});
```

### Authentication

- Auth tokens are transmitted as `String` type in `AUTH` frames — they are **not encrypted** by the protocol itself
- Use `wss://` (WebSocket over TLS) in production to protect tokens in transit
- Auth timeout (default 5s) closes connections that don't authenticate in time
- `server.reject(uuid, reason)` immediately closes the connection

### Data Direction

dan-websocket is **server-to-client only**. Clients cannot write arbitrary data to the server state. The only client-to-server data is:
- `IDENTIFY` frame (UUID)
- `AUTH` frame (token string)
- Topic subscription frames (topic names + params)

### Protocol Safety

- **DLE-encoded framing** — self-synchronizing on stream corruption
- **Type validation** — `serialize()` validates value matches declared DataType
- **Key path validation** — max 200 bytes, restricted character set
- **Flatten depth limit** — max 10 levels, circular reference detection

## Transport Security

dan-websocket does not provide transport-layer encryption on its own. In production environments, always use **`wss://`** (WebSocket over TLS) rather than plain `ws://`. This ensures that all data on the wire -- including auth tokens, state updates, and subscription parameters -- is encrypted in transit.

**Recommendations:**

- Terminate TLS at a reverse proxy (e.g., nginx, Caddy, or a cloud load balancer) and forward to your dan-websocket server over localhost.
- If exposing the WebSocket server directly, configure your HTTP server with a valid TLS certificate (e.g., via Let's Encrypt) and pass the HTTPS server instance to `DanWebSocketServer`.
- Never transmit auth tokens over unencrypted `ws://` connections in production. The `AUTH` frame payload is sent as a plain string and is visible to any network observer without TLS.

```typescript
import { createServer } from "https";
import { readFileSync } from "fs";
import { DanWebSocketServer } from "dan-websocket/server";

const httpsServer = createServer({
  cert: readFileSync("/path/to/cert.pem"),
  key: readFileSync("/path/to/key.pem"),
});

const ws = new DanWebSocketServer({
  server: httpsServer,
  path: "/ws",
  mode: "broadcast",
});

httpsServer.listen(443);
// Clients connect via wss://your-domain.com/ws
```

---

## Supported Versions

| Version | Supported |
|---------|-----------|
| 2.x     | Yes       |
| < 2.0   | No        |
