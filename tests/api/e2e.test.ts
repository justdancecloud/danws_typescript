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
  for (const c of clients) {
    try { c.disconnect(); } catch {}
  }
  clients = [];
  if (server) {
    try { server.close(); } catch {}
    server = null;
  }
});

function createServer(port: number, mode: "broadcast" | "individual" = "individual") {
  server = new DanWebSocketServer({ port, path: "/ws", mode });
  return server;
}

function createClient(port: number, opts?: Parameters<typeof DanWebSocketClient.prototype.constructor>[1]) {
  const c = new DanWebSocketClient(`ws://127.0.0.1:${port}/ws`, opts);
  clients.push(c);
  return c;
}

describe("E2E: Individual Mode", () => {
  it("basic connect, handshake, and value exchange", async () => {
    const srv = createServer(19001);
    await waitFor(50);

    const receivedByServer: Array<{ key: string; value: unknown }> = [];
    const receivedByClient: Array<{ key: string; value: unknown }> = [];

    srv.onConnection((session) => {
      session.tx.updateKeys([
        { path: "greeting", type: DataType.String },
        { path: "count", type: DataType.Uint32 },
      ]);
      session.tx.set("greeting", "Hello");
      session.tx.set("count", 42);

      session.rx.onReceive((key, value) => {
        receivedByServer.push({ key, value });
      });
    });

    const client = createClient(19001);
    client.tx.updateKeys([
      { path: "input.x", type: DataType.Float32 },
    ]);

    client.rx.onReceive((key, value) => {
      receivedByClient.push({ key, value });
    });

    let clientReady = false;
    client.onReady(() => { clientReady = true; });

    client.connect();

    await waitUntil(() => clientReady, 3000);

    expect(client.state).toBe("ready");
    expect(client.rx.get("greeting")).toBe("Hello");
    expect(client.rx.get("count")).toBe(42);

    // Send value from client
    client.tx.set("input.x", 1.5);
    await waitFor(200); // Wait for bulk flush

    expect(receivedByServer.length).toBeGreaterThanOrEqual(1);
    expect(receivedByServer.some(r => r.key === "input.x")).toBe(true);
  });

  it("server sends value update after ready", async () => {
    const srv = createServer(19002);
    await waitFor(50);

    let sessionRef: any = null;
    srv.onConnection((session) => {
      sessionRef = session;
      session.tx.updateKeys([
        { path: "score", type: DataType.Uint32 },
      ]);
      session.tx.set("score", 0);
    });

    const client = createClient(19002);
    const values: unknown[] = [];

    let ready = false;
    client.onReady(() => { ready = true; });
    client.rx.onReceive((key, value) => {
      if (key === "score") values.push(value);
    });

    client.connect();
    await waitUntil(() => ready);
    await waitFor(300); // Wait for initial value sync

    expect(values).toContain(0);

    // Update server-side value
    sessionRef.tx.set("score", 100);
    await waitFor(300);

    expect(values).toContain(100);
  });

  it("multiple clients get independent sessions", async () => {
    const srv = createServer(19003);
    await waitFor(50);

    let sessionCount = 0;
    srv.onConnection((session) => {
      sessionCount++;
      session.tx.updateKeys([
        { path: "id", type: DataType.String },
      ]);
      session.tx.set("id", session.id);
    });

    const c1 = createClient(19003);
    const c2 = createClient(19003);

    let r1 = false, r2 = false;
    c1.onReady(() => { r1 = true; });
    c2.onReady(() => { r2 = true; });

    c1.connect();
    c2.connect();

    await waitUntil(() => r1 && r2);

    await waitFor(300); // Wait for value sync
    expect(sessionCount).toBe(2);
    expect(c1.rx.get("id")).toBe(c1.id);
    expect(c2.rx.get("id")).toBe(c2.id);
  });
});

describe("E2E: Broadcast Mode", () => {
  it("all clients receive same broadcast data", async () => {
    const srv = createServer(19004, "broadcast");
    await waitFor(50);

    srv.tx.updateKeys([
      { path: "sensor.temp", type: DataType.Float32 },
    ]);
    srv.tx.set("sensor.temp", 23.5);

    const c1 = createClient(19004);
    const c2 = createClient(19004);

    let r1 = false, r2 = false;
    c1.onReady(() => { r1 = true; });
    c2.onReady(() => { r2 = true; });

    c1.connect();
    c2.connect();

    await waitUntil(() => r1 && r2);
    await waitFor(300); // Wait for value sync

    // Float32 precision
    expect(c1.rx.get("sensor.temp")).toBeCloseTo(23.5, 1);
    expect(c2.rx.get("sensor.temp")).toBeCloseTo(23.5, 1);
  });
});

describe("E2E: Authentication", () => {
  it("auth flow: accept", async () => {
    const srv = createServer(19005);
    await waitFor(50);

    srv.enableAuthorization(true, { timeout: 5000 });

    srv.onAuthorize((uuid, token) => {
      if (token === "valid-token") {
        srv.authorize(uuid, token, "alice");
      } else {
        srv.reject(uuid, "bad token");
      }
    });

    srv.onConnection((session) => {
      session.tx.updateKeys([
        { path: "user.name", type: DataType.String },
      ]);
      session.tx.set("user.name", session.username!);
    });

    const client = createClient(19005);
    client.onConnect(() => {
      client.authorize("valid-token");
    });

    let ready = false;
    client.onReady(() => { ready = true; });

    client.connect();
    await waitUntil(() => ready);
    await waitFor(300); // Wait for value sync

    expect(client.rx.get("user.name")).toBe("alice");
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

    client.onConnect(() => {
      client.authorize("bad-token");
    });

    client.onError((err) => {
      errors.push(err.code);
    });

    client.connect();
    await waitFor(500);

    expect(errors).toContain("AUTH_REJECTED");
    expect(client.state).toBe("disconnected");
  });
});

describe("E2E: Session management", () => {
  it("getSession and isConnected", async () => {
    const srv = createServer(19007);
    await waitFor(50);

    let uuid = "";
    srv.onConnection((session) => {
      uuid = session.id;
      session.tx.updateKeys([{ path: "x", type: DataType.Bool }]);
      session.tx.set("x", true);
    });

    const client = createClient(19007);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();

    await waitUntil(() => ready);

    expect(srv.isConnected(uuid)).toBe(true);
    expect(srv.getSession(uuid)).not.toBeNull();
    expect(srv.getSession(uuid)!.id).toBe(uuid);

    client.disconnect();
    await waitFor(200);

    expect(srv.isConnected(uuid)).toBe(false);
    // Session still exists within TTL
    expect(srv.getSession(uuid)).not.toBeNull();
  });
});
