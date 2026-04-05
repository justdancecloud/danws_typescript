import { describe, it, expect, afterEach } from "vitest";
import { DanWebSocketServer } from "../../src/api/server.js";
import { DanWebSocketClient } from "../../src/api/client.js";

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

describe("E2E: Auto-type set() API", () => {
  it("set values, client receives them", async () => {
    const srv = createServer(19001);
    await waitFor(50);

    // Just set — no updateKeys needed
    srv.principal("default").set("greeting", "Hello");
    srv.principal("default").set("count", 42);
    srv.principal("default").set("active", true);

    const client = createClient(19001);
    const received: Array<{ key: string; value: unknown }> = [];
    client.onReceive((key, value) => received.push({ key, value }));

    let ready = false;
    client.onReady(() => { ready = true; });

    client.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    expect(client.get("greeting")).toBe("Hello");
    expect(client.get("count")).toBe(42);
    expect(client.get("active")).toBe(true);
    expect(client.keys.sort()).toEqual(["active", "count", "greeting"]);
    expect(received.length).toBeGreaterThanOrEqual(3);
  });

  it("server updates value after client ready", async () => {
    const srv = createServer(19002);
    await waitFor(50);

    srv.principal("default").set("score", 0);

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

    srv.principal("default").set("score", 100);
    await waitFor(200);

    expect(values).toContain(100);
  });

  it("principal.keys returns registered keys", async () => {
    const srv = createServer(19003);
    await waitFor(50);

    srv.principal("test").set("a", 1);
    srv.principal("test").set("b", "hello");
    srv.principal("test").set("c", true);

    expect(srv.principal("test").keys.sort()).toEqual(["a", "b", "c"]);
  });

  it("clear(key) removes a single key", async () => {
    const srv = createServer(19004);
    await waitFor(50);

    srv.principal("test").set("a", 1);
    srv.principal("test").set("b", 2);

    srv.principal("test").clear("a");
    expect(srv.principal("test").keys).toEqual(["b"]);
    expect(srv.principal("test").get("a")).toBeUndefined();
  });

  it("clear() removes all keys", async () => {
    const srv = createServer(19005);
    await waitFor(50);

    srv.principal("test").set("a", 1);
    srv.principal("test").set("b", 2);

    srv.principal("test").clear();
    expect(srv.principal("test").keys).toEqual([]);
  });

  it("auto-detects various types", async () => {
    const srv = createServer(19006);
    await waitFor(50);

    srv.principal("default").set("str", "hello");
    srv.principal("default").set("num", 3.14);
    srv.principal("default").set("bool", false);
    srv.principal("default").set("big", 9007199254740993n);
    srv.principal("default").set("bin", new Uint8Array([0xde, 0xad]));
    srv.principal("default").set("date", new Date("2026-01-01T00:00:00Z"));
    srv.principal("default").set("nil", null);

    const client = createClient(19006);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    expect(client.get("str")).toBe("hello");
    expect(client.get("num")).toBeCloseTo(3.14);
    expect(client.get("bool")).toBe(false);
    expect(client.get("big")).toBe(9007199254740993n);
    expect(client.get("bin")).toEqual(new Uint8Array([0xde, 0xad]));
    expect((client.get("date") as Date).getTime()).toBe(new Date("2026-01-01T00:00:00Z").getTime());
    expect(client.get("nil")).toBe(null);
  });
});

describe("E2E: Principal sharing", () => {
  it("multiple clients share same principal data", async () => {
    const srv = createServer(19010);
    await waitFor(50);

    srv.principal("shared").set("data", "shared-value");

    srv.enableAuthorization(true);
    srv.onAuthorize((uuid, token) => {
      srv.authorize(uuid, token, "shared");
    });

    const c1 = createClient(19010);
    const c2 = createClient(19010);
    c1.onConnect(() => c1.authorize("t1"));
    c2.onConnect(() => c2.authorize("t2"));

    let r1 = false, r2 = false;
    c1.onReady(() => { r1 = true; });
    c2.onReady(() => { r2 = true; });

    c1.connect();
    c2.connect();
    await waitUntil(() => r1 && r2);
    await waitFor(200);

    expect(c1.get("data")).toBe("shared-value");
    expect(c2.get("data")).toBe("shared-value");

    // Update — both get it
    srv.principal("shared").set("data", "updated");
    await waitFor(200);

    expect(c1.get("data")).toBe("updated");
    expect(c2.get("data")).toBe("updated");
  });

  it("different principals get different data", async () => {
    const srv = createServer(19011);
    await waitFor(50);

    srv.principal("alice").set("name", "Alice");
    srv.principal("bob").set("name", "Bob");

    srv.enableAuthorization(true);
    srv.onAuthorize((uuid, token) => {
      srv.authorize(uuid, token, token);
    });

    const cA = createClient(19011);
    const cB = createClient(19011);
    cA.onConnect(() => cA.authorize("alice"));
    cB.onConnect(() => cB.authorize("bob"));

    let rA = false, rB = false;
    cA.onReady(() => { rA = true; });
    cB.onReady(() => { rB = true; });

    cA.connect();
    cB.connect();
    await waitUntil(() => rA && rB);
    await waitFor(200);

    expect(cA.get("name")).toBe("Alice");
    expect(cB.get("name")).toBe("Bob");
  });
});

describe("E2E: Authentication", () => {
  it("auth reject", async () => {
    const srv = createServer(19020);
    await waitFor(50);

    srv.enableAuthorization(true);
    srv.onAuthorize((uuid) => srv.reject(uuid, "denied"));

    const client = createClient(19020, { reconnect: { enabled: false } });
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
  it("getSessionsByPrincipal and isConnected", async () => {
    const srv = createServer(19030);
    await waitFor(50);

    srv.enableAuthorization(true);
    srv.onAuthorize((uuid, token) => srv.authorize(uuid, token, "alice"));

    srv.principal("alice").set("x", true);

    let uuid = "";
    srv.onConnection((s) => { uuid = s.id; });

    const client = createClient(19030);
    client.onConnect(() => client.authorize("token"));
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();

    await waitUntil(() => ready);

    expect(srv.isConnected(uuid)).toBe(true);
    expect(srv.getSession(uuid)!.principal).toBe("alice");
    expect(srv.getSessionsByPrincipal("alice")).toHaveLength(1);

    client.disconnect();
    await waitFor(200);

    expect(srv.isConnected(uuid)).toBe(false);
    expect(srv.getSession(uuid)).not.toBeNull();
  });
});
