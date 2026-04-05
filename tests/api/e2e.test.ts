import { describe, it, expect, afterEach } from "vitest";
import { DanWebSocketServer } from "../../src/api/server.js";
import { DanWebSocketClient } from "../../src/api/client.js";
import { DataType } from "../../src/protocol/types.js";

function waitFor(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function waitUntil(fn: () => boolean, timeout = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (fn()) return resolve();
      if (Date.now() - start > timeout) return reject(new Error("waitUntil timeout"));
      setTimeout(check, 10);
    };
    check();
  });
}

let server: DanWebSocketServer | null = null;
let clients: DanWebSocketClient[] = [];

afterEach(() => {
  for (const c of clients) { try { c.disconnect(); } catch {} }
  clients = [];
  if (server) { try { server.close(); } catch {} server = null; }
});

function createServer(port: number) {
  server = new DanWebSocketServer({ port, path: "/ws" });
  return server;
}

function createClient(port: number, opts?: any) {
  const c = new DanWebSocketClient(`ws://127.0.0.1:${port}/ws`, opts);
  clients.push(c);
  return c;
}

describe("E2E: Principal-based Server→Client", () => {
  it("basic connect, handshake, and value sync", async () => {
    const srv = createServer(19001);
    await waitFor(50);

    // Set up principal data before any connection
    srv.tx.principal("default").updateKeys([
      { path: "greeting", type: DataType.String },
      { path: "count", type: DataType.Uint32 },
    ]);
    srv.tx.principal("default").set("greeting", "Hello");
    srv.tx.principal("default").set("count", 42);

    srv.onConnection((session) => {
      // No-auth: principal is "" by default
    });

    const client = createClient(19001);
    const received: Array<{ key: string; value: unknown }> = [];
    client.onReceive((key, value) => received.push({ key, value }));

    let ready = false;
    client.onReady(() => { ready = true; });

    client.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    expect(client.state).toBe("ready");
    expect(client.get("greeting")).toBe("Hello");
    expect(client.get("count")).toBe(42);
    expect(received.length).toBeGreaterThanOrEqual(2);
  });

  it("server updates value after client ready", async () => {
    const srv = createServer(19002);
    await waitFor(50);

    srv.tx.principal("default").updateKeys([
      { path: "score", type: DataType.Uint32 },
    ]);
    srv.tx.principal("default").set("score", 0);

    const client = createClient(19002);
    const values: unknown[] = [];

    let ready = false;
    client.onReady(() => { ready = true; });
    client.onReceive((key, value) => {
      if (key === "score") values.push(value);
    });

    client.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    expect(values).toContain(0);

    srv.tx.principal("default").set("score", 100);
    await waitFor(200);

    expect(values).toContain(100);
  });

  it("multiple clients share same principal data", async () => {
    const srv = createServer(19003);
    await waitFor(50);

    srv.tx.principal("shared").updateKeys([
      { path: "data", type: DataType.String },
    ]);
    srv.tx.principal("shared").set("data", "shared-value");

    // Both clients connect with auth → same principal
    srv.enableAuthorization(true);
    srv.onAuthorize((uuid, token) => {
      srv.authorize(uuid, token, "shared");
    });

    const c1 = createClient(19003);
    const c2 = createClient(19003);

    c1.onConnect(() => c1.authorize("token1"));
    c2.onConnect(() => c2.authorize("token2"));

    let r1 = false, r2 = false;
    c1.onReady(() => { r1 = true; });
    c2.onReady(() => { r2 = true; });

    c1.connect();
    c2.connect();

    await waitUntil(() => r1 && r2);
    await waitFor(200);

    expect(c1.get("data")).toBe("shared-value");
    expect(c2.get("data")).toBe("shared-value");

    // Update via principal — both clients should get it
    srv.tx.principal("shared").set("data", "updated");
    await waitFor(200);

    expect(c1.get("data")).toBe("updated");
    expect(c2.get("data")).toBe("updated");
  });

  it("different principals get different data", async () => {
    const srv = createServer(19004);
    await waitFor(50);

    srv.tx.principal("alice").updateKeys([
      { path: "name", type: DataType.String },
    ]);
    srv.tx.principal("alice").set("name", "Alice");

    srv.tx.principal("bob").updateKeys([
      { path: "name", type: DataType.String },
    ]);
    srv.tx.principal("bob").set("name", "Bob");

    srv.enableAuthorization(true);
    srv.onAuthorize((uuid, token) => {
      srv.authorize(uuid, token, token); // token = principal name
    });

    const cAlice = createClient(19004);
    const cBob = createClient(19004);

    cAlice.onConnect(() => cAlice.authorize("alice"));
    cBob.onConnect(() => cBob.authorize("bob"));

    let rA = false, rB = false;
    cAlice.onReady(() => { rA = true; });
    cBob.onReady(() => { rB = true; });

    cAlice.connect();
    cBob.connect();

    await waitUntil(() => rA && rB);
    await waitFor(200);

    expect(cAlice.get("name")).toBe("Alice");
    expect(cBob.get("name")).toBe("Bob");
  });
});

describe("E2E: Authentication", () => {
  it("auth flow: accept", async () => {
    const srv = createServer(19005);
    await waitFor(50);

    srv.enableAuthorization(true);
    srv.onAuthorize((uuid, token) => {
      if (token === "valid") {
        srv.authorize(uuid, token, "alice");
      } else {
        srv.reject(uuid, "bad token");
      }
    });

    srv.tx.principal("alice").updateKeys([
      { path: "user.name", type: DataType.String },
    ]);
    srv.tx.principal("alice").set("user.name", "Alice");

    const client = createClient(19005);
    client.onConnect(() => client.authorize("valid"));

    let ready = false;
    client.onReady(() => { ready = true; });

    client.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    expect(client.get("user.name")).toBe("Alice");
  });

  it("auth flow: reject", async () => {
    const srv = createServer(19006);
    await waitFor(50);

    srv.enableAuthorization(true);
    srv.onAuthorize((uuid, token) => {
      srv.reject(uuid, "denied");
    });

    const client = createClient(19006, { reconnect: { enabled: false } });
    const errors: string[] = [];

    client.onConnect(() => client.authorize("bad"));
    client.onError((err) => errors.push(err.code));

    client.connect();
    await waitFor(500);

    expect(errors).toContain("AUTH_REJECTED");
    expect(client.state).toBe("disconnected");
  });
});

describe("E2E: Session management", () => {
  it("getSession, getSessionsByPrincipal, isConnected", async () => {
    const srv = createServer(19007);
    await waitFor(50);

    srv.enableAuthorization(true);
    srv.onAuthorize((uuid, token) => {
      srv.authorize(uuid, token, "alice");
    });

    srv.tx.principal("alice").updateKeys([
      { path: "x", type: DataType.Bool },
    ]);
    srv.tx.principal("alice").set("x", true);

    let uuid = "";
    srv.onConnection((session) => { uuid = session.id; });

    const client = createClient(19007);
    client.onConnect(() => client.authorize("token"));

    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();

    await waitUntil(() => ready);

    expect(srv.isConnected(uuid)).toBe(true);
    expect(srv.getSession(uuid)).not.toBeNull();
    expect(srv.getSession(uuid)!.principal).toBe("alice");
    expect(srv.getSessionsByPrincipal("alice")).toHaveLength(1);

    client.disconnect();
    await waitFor(200);

    expect(srv.isConnected(uuid)).toBe(false);
    expect(srv.getSession(uuid)).not.toBeNull(); // Still within TTL
    expect(srv.getSessionsByPrincipal("alice")).toHaveLength(1);
  });
});
