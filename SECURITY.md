# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 2.4.x   | Yes (current) |
| 2.3.x   | Yes |
| 2.2.x   | Security fixes only |
| < 2.2   | No |

## Reporting Vulnerabilities

If you discover a security vulnerability, please report it privately:

- **Email**: Open a private security advisory at https://github.com/justdancecloud/danws_typescript/security/advisories
- **GitHub Issues**: For non-sensitive issues, open an issue at https://github.com/justdancecloud/danws_typescript/issues

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact

We will respond within 48 hours and aim to release a fix within 7 days for critical issues.

## Security Design

### Transport Security

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

### Message Size Limits

dan-websocket enforces size limits at two levels to prevent memory exhaustion attacks:

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

These limits protect against:
- Denial-of-service via large payloads
- Memory exhaustion from accumulated stream data
- Individual oversized values consuming server resources

### Authentication Flow Security

- Auth tokens are transmitted as `String` type in `AUTH` frames -- they are **not encrypted** by the protocol itself. Use `wss://` to protect tokens.
- Auth timeout (default 5s) closes connections that do not authenticate in time, preventing resource exhaustion from idle connections.
- `server.reject(uuid, reason)` immediately closes the connection and sends an `AuthFail` frame with the reason.
- Principal-based sessions ensure that authentication state is per-user, not per-connection. Multiple devices sharing the same principal receive the same state.

### Data Direction

dan-websocket is **server-to-client only** for state data. Clients cannot write arbitrary data to the server state. The only client-to-server data is:
- `IDENTIFY` frame (UUID)
- `AUTH` frame (token string)
- Topic subscription frames (topic names + params)
- Control frames (ClientReady, ClientResyncReq, ClientKeyRequest)

### VarNumber Encoding

The VarInteger (0x0D), VarDouble (0x0E), and VarFloat (0x0F) data types introduced in v3.5 are wire format optimizations only. They have **no security implications** beyond normal protocol parsing:
- VarInt decoding is bounded (max 9 bytes for 64-bit values)
- VarDouble fallback mode is a fixed 9 bytes (1 flag byte + 8 bytes IEEE 754)
- VarFloat fallback mode is a fixed 5 bytes (1 flag byte + 4 bytes IEEE 754)
- No additional attack surface is introduced compared to fixed-width numeric types

### Protocol Safety

- **DLE-encoded framing** -- self-synchronizing on stream corruption
- **Type validation** -- `serialize()` validates value matches declared DataType
- **Key path validation** -- max 200 bytes, restricted character set (`[a-zA-Z0-9_]` segments separated by `.`)
- **Flatten depth limit** -- max 10 levels, circular reference detection
- **freedKeyIds pool** -- capped at 10,000 entries to bound memory usage
- **crypto.getRandomValues** -- used for UUID generation with fallback for browser environments
