import { describe, it, expect, afterEach } from "vitest";
import { DanWebSocketServer } from "../../src/api/server.js";
import { DanWebSocketClient } from "../../src/api/client.js";

function waitFor(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function waitUntil(fn: () => boolean, timeout = 15000): Promise<void> {
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

function createClient(port: number, opts?: any) {
  const c = new DanWebSocketClient(`ws://127.0.0.1:${port}/ws`, opts);
  clients.push(c);
  return c;
}

// ────────────────────────────────────────────────
// Broadcast Mode: server.set(key, value)
// ────────────────────────────────────────────────

describe("E2E: Broadcast Mode", () => {
  it("server.set() syncs to all clients", async () => {
    server = new DanWebSocketServer({ port: 19001, path: "/ws", mode: "broadcast" });
    await waitFor(50);

    server.set("greeting", "Hello");
    server.set("count", 42);
    server.set("active", true);

    const c1 = createClient(19001);
    const c2 = createClient(19001);

    let r1 = false, r2 = false;
    c1.onReady(() => { r1 = true; });
    c2.onReady(() => { r2 = true; });

    c1.connect();
    c2.connect();
    await waitUntil(() => r1 && r2);
    await waitFor(200);

    expect(c1.get("greeting")).toBe("Hello");
    expect(c1.get("count")).toBe(42);
    expect(c1.get("active")).toBe(true);

    expect(c2.get("greeting")).toBe("Hello");
    expect(c2.get("count")).toBe(42);
  });

  it("server.set() update after clients connected", async () => {
    server = new DanWebSocketServer({ port: 19002, path: "/ws", mode: "broadcast" });
    await waitFor(50);

    server.set("score", 0);

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

    server.set("score", 100);
    await waitFor(200);

    expect(values).toContain(100);
    expect(client.get("score")).toBe(100);
  });

  it("server.get(), server.keys, server.clear()", async () => {
    server = new DanWebSocketServer({ port: 19003, path: "/ws", mode: "broadcast" });

    server.set("a", 1);
    server.set("b", "hello");
    server.set("c", true);

    expect(server.get("a")).toBe(1);
    expect(server.keys.sort()).toEqual(["a", "b", "c"]);

    server.clear("a");
    expect(server.get("a")).toBeUndefined();
    expect(server.keys.sort()).toEqual(["b", "c"]);

    server.clear();
    expect(server.keys).toEqual([]);
  });

  it("auto-detects all types", async () => {
    server = new DanWebSocketServer({ port: 19004, path: "/ws", mode: "broadcast" });
    await waitFor(50);

    server.set("str", "hello");
    server.set("num", 3.14);
    server.set("bool", false);
    server.set("big", 9007199254740993n);
    server.set("bin", new Uint8Array([0xde, 0xad]));
    server.set("date", new Date("2026-01-01T00:00:00Z"));
    server.set("nil", null);

    const client = createClient(19004);
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

  it("broadcast mode rejects server.principal()", () => {
    server = new DanWebSocketServer({ port: 19005, path: "/ws", mode: "broadcast" });
    expect(() => server!.principal("alice")).toThrow();
  });
});

// ────────────────────────────────────────────────
// Individual Mode: server.principal(name).set(key, value)
// ────────────────────────────────────────────────

describe("E2E: Individual Mode", () => {
  it("principal-based data sync", async () => {
    server = new DanWebSocketServer({ port: 19010, path: "/ws", mode: "principal" });
    await waitFor(50);

    server.principal("default").set("greeting", "Hello");
    server.principal("default").set("count", 42);

    const client = createClient(19010);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    expect(client.get("greeting")).toBe("Hello");
    expect(client.get("count")).toBe(42);
  });

  it("different principals get different data", async () => {
    server = new DanWebSocketServer({ port: 19011, path: "/ws", mode: "principal" });
    await waitFor(50);

    server.principal("alice").set("name", "Alice");
    server.principal("bob").set("name", "Bob");

    server.enableAuthorization(true);
    server.onAuthorize((uuid, token) => server!.authorize(uuid, token, token));

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

  it("multiple sessions share same principal", async () => {
    server = new DanWebSocketServer({ port: 19012, path: "/ws", mode: "principal" });
    await waitFor(50);

    server.principal("shared").set("data", "shared-value");

    server.enableAuthorization(true);
    server.onAuthorize((uuid, token) => server!.authorize(uuid, token, "shared"));

    const c1 = createClient(19012);
    const c2 = createClient(19012);
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

    server.principal("shared").set("data", "updated");
    await waitFor(200);

    expect(c1.get("data")).toBe("updated");
    expect(c2.get("data")).toBe("updated");
  });

  it("individual mode rejects server.set()", () => {
    server = new DanWebSocketServer({ port: 19013, path: "/ws", mode: "principal" });
    expect(() => server!.set("key", "val")).toThrow();
  });
});

// ────────────────────────────────────────────────
// Authentication
// ────────────────────────────────────────────────

describe("E2E: Authentication", () => {
  it("auth accept", async () => {
    server = new DanWebSocketServer({ port: 19020, path: "/ws", mode: "principal" });
    await waitFor(50);

    server.enableAuthorization(true);
    server.onAuthorize((uuid, token) => {
      if (token === "valid") server!.authorize(uuid, token, "alice");
      else server!.reject(uuid, "bad token");
    });

    server.principal("alice").set("user.name", "Alice");

    const client = createClient(19020);
    client.onConnect(() => client.authorize("valid"));

    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    expect(client.get("user.name")).toBe("Alice");
  });

  it("auth reject", async () => {
    server = new DanWebSocketServer({ port: 19021, path: "/ws", mode: "principal" });
    await waitFor(50);

    server.enableAuthorization(true);
    server.onAuthorize((uuid) => server!.reject(uuid, "denied"));

    const client = createClient(19021, { reconnect: { enabled: false } });
    const errors: string[] = [];
    client.onConnect(() => client.authorize("bad"));
    client.onError((err) => errors.push(err.code));

    client.connect();
    await waitFor(500);

    expect(errors).toContain("AUTH_REJECTED");
    expect(client.state).toBe("disconnected");
  });
});

// ────────────────────────────────────────────────
// Session management
// ────────────────────────────────────────────────

describe("E2E: Session management", () => {
  it("getSessionsByPrincipal and isConnected", async () => {
    server = new DanWebSocketServer({ port: 19030, path: "/ws", mode: "principal" });
    await waitFor(50);

    server.enableAuthorization(true);
    server.onAuthorize((uuid, token) => server!.authorize(uuid, token, "alice"));
    server.principal("alice").set("x", true);

    let uuid = "";
    server.onConnection((s) => { uuid = s.id; });

    const client = createClient(19030);
    client.onConnect(() => client.authorize("token"));
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();

    await waitUntil(() => ready);

    expect(server.isConnected(uuid)).toBe(true);
    expect(server.getSession(uuid)!.principal).toBe("alice");
    expect(server.getSessionsByPrincipal("alice")).toHaveLength(1);

    client.disconnect();
    await waitFor(200);

    expect(server.isConnected(uuid)).toBe(false);
    expect(server.getSession(uuid)).not.toBeNull(); // Within TTL
  });
});
