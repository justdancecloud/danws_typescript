/**
 * v1.0 Final Validation Tests
 * Comprehensive coverage for all features before v1.0 release.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer as createHttpServer } from "http";
import { DanWebSocketServer, EventType } from "../../src/api/server.js";
import { DanWebSocketClient } from "../../src/api/client.js";

const BASE_PORT = 19800;
let portCounter = 0;
function nextPort(): number { return BASE_PORT + portCounter++; }

function waitFor(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
function waitUntil(fn: () => boolean, timeout = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (fn()) return resolve();
      if (Date.now() - start > timeout) return reject(new Error("Timeout"));
      setTimeout(check, 20);
    };
    check();
  });
}

let server: DanWebSocketServer | null = null;
let httpServer: ReturnType<typeof createHttpServer> | null = null;
const clients: DanWebSocketClient[] = [];

function createClient(port: number, path = "/") {
  const url = path === "/" ? `ws://127.0.0.1:${port}` : `ws://127.0.0.1:${port}${path}`;
  const c = new DanWebSocketClient(url, { reconnect: { enabled: false } });
  clients.push(c);
  return c;
}

afterEach(async () => {
  for (const c of clients) { try { c.disconnect(); } catch {} }
  clients.length = 0;
  if (server) { server.close(); server = null; }
  if (httpServer) { httpServer.close(); httpServer = null; }
  await waitFor(50);
});

// ════════════════════════════════════════
// 1. Server Options
// ════════════════════════════════════════

describe("Server Options", () => {
  it("custom path option", async () => {
    const port = nextPort();
    server = new DanWebSocketServer({ port, mode: "broadcast", path: "/ws" });
    server.set("hello", "world");

    const c = createClient(port, "/ws");
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    expect(c.get("hello")).toBe("world");
  });

  it("wrong path rejects connection", async () => {
    const port = nextPort();
    server = new DanWebSocketServer({ port, mode: "broadcast", path: "/ws" });

    const c = createClient(port, "/wrong");
    let error = false;
    c.onError(() => { error = true; });
    c.onDisconnect(() => { error = true; });
    c.connect();
    await waitFor(500);

    expect(c.state).not.toBe("ready");
  });

  it("http server option instead of port", async () => {
    const port = nextPort();
    httpServer = createHttpServer();
    await new Promise<void>(resolve => httpServer!.listen(port, resolve));

    server = new DanWebSocketServer({ server: httpServer, mode: "broadcast" });
    server.set("msg", "via http server");

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    expect(c.get("msg")).toBe("via http server");
  });

  it("session TTL option", async () => {
    const port = nextPort();
    server = new DanWebSocketServer({ port, mode: "broadcast", session: { ttl: 200 } });
    server.set("x", 1);

    let sessionId = "";
    server.onConnection((s) => { sessionId = s.id; });

    const expired: string[] = [];
    server.onSessionExpired((s) => { expired.push(s.id); });

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);

    c.disconnect();
    await waitFor(500); // TTL=200ms, wait well past it

    expect(expired).toContain(sessionId);
  });

  it("debug option logs callback errors", async () => {
    const port = nextPort();
    const logs: string[] = [];
    server = new DanWebSocketServer({
      port, mode: "broadcast",
      debug: (msg) => logs.push(msg),
    });

    server.onConnection(() => { throw new Error("test error"); });
    server.set("x", 1);

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);

    expect(logs.some(l => l.includes("onConnection"))).toBe(true);
  });

  it("enableAuthorization with custom timeout", async () => {
    const port = nextPort();
    server = new DanWebSocketServer({ port, mode: "principal" });
    server.enableAuthorization(true, { timeout: 200 });

    const c = createClient(port);
    let disconnected = false;
    c.onDisconnect(() => { disconnected = true; });
    c.connect();

    // Don't send auth → should timeout and disconnect
    await waitFor(500);
    expect(disconnected).toBe(true);
  });
});

// ════════════════════════════════════════
// 2. Auto-Flatten Stress Tests
// ════════════════════════════════════════

describe("Auto-Flatten Stress", () => {
  it("50+ keys from single object", async () => {
    const port = nextPort();
    server = new DanWebSocketServer({ port, mode: "broadcast" });

    const bigObj: Record<string, number> = {};
    for (let i = 0; i < 60; i++) bigObj[`field${i}`] = i;
    server.set("big", bigObj);

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(300);

    for (let i = 0; i < 60; i++) {
      expect(c.get(`big.field${i}`)).toBe(i);
    }
  });

  it("array of 100 items", async () => {
    const port = nextPort();
    server = new DanWebSocketServer({ port, mode: "broadcast" });

    const arr = Array.from({ length: 100 }, (_, i) => i * 10);
    server.set("nums", arr);

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(300);

    expect(c.get("nums.length")).toBe(100);
    expect(c.get("nums.0")).toBe(0);
    expect(c.get("nums.99")).toBe(990);
    expect(c.data.nums.length).toBe(100);
  });

  it("deeply nested (depth 8)", async () => {
    const port = nextPort();
    server = new DanWebSocketServer({ port, mode: "broadcast" });

    let obj: any = { leaf: "deep" };
    for (let i = 0; i < 7; i++) obj = { level: obj };
    server.set("nest", obj);

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(300);

    expect(c.get("nest.level.level.level.level.level.level.level.leaf")).toBe("deep");
    expect(c.data.nest.level.level.level.level.level.level.level.leaf).toBe("deep");
  });

  it("rapid object updates (same key, 20 times)", async () => {
    const port = nextPort();
    server = new DanWebSocketServer({ port, mode: "broadcast" });
    server.set("counter", { value: 0 });

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(100);

    // Rapidly update
    for (let i = 1; i <= 20; i++) {
      server.set("counter", { value: i });
    }
    await waitFor(500);

    expect(c.get("counter.value")).toBe(20);
  });

  it("mixed types in object — string, number, boolean, null, Date", async () => {
    const port = nextPort();
    server = new DanWebSocketServer({ port, mode: "broadcast" });

    const now = new Date();
    server.set("mixed", {
      name: "test",
      count: 42,
      active: true,
      disabled: false,
      data: null,
      created: now,
    });

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(300);

    expect(c.get("mixed.name")).toBe("test");
    expect(c.get("mixed.count")).toBe(42);
    expect(c.get("mixed.active")).toBe(true);
    expect(c.get("mixed.disabled")).toBe(false);
    expect(c.get("mixed.data")).toBe(null);
    const ts = c.get("mixed.created") as Date;
    expect(ts.getTime()).toBe(now.getTime());
  });

  it("array shrink from 50 to 5 cleans all extras", async () => {
    const port = nextPort();
    server = new DanWebSocketServer({ port, mode: "broadcast" });

    server.set("list", Array.from({ length: 50 }, (_, i) => i));

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(300);

    expect(c.get("list.length")).toBe(50);
    expect(c.get("list.49")).toBe(49);

    server.set("list", [100, 200, 300, 400, 500]);
    await waitFor(400);

    expect(c.get("list.length")).toBe(5);
    expect(c.get("list.0")).toBe(100);
    expect(c.get("list.4")).toBe(500);
    expect(c.get("list.5")).toBeUndefined();
    expect(c.get("list.49")).toBeUndefined();
  });

  it("object key removal when structure changes", async () => {
    const port = nextPort();
    server = new DanWebSocketServer({ port, mode: "broadcast" });

    server.set("config", { a: 1, b: 2, c: 3 });

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(300);

    expect(c.get("config.a")).toBe(1);
    expect(c.get("config.b")).toBe(2);
    expect(c.get("config.c")).toBe(3);

    // Remove key b, add key d
    server.set("config", { a: 10, c: 30, d: 40 });
    await waitFor(400);

    expect(c.get("config.a")).toBe(10);
    expect(c.get("config.b")).toBeUndefined();
    expect(c.get("config.c")).toBe(30);
    expect(c.get("config.d")).toBe(40);
  });

  it("empty object and empty array", async () => {
    const port = nextPort();
    server = new DanWebSocketServer({ port, mode: "broadcast" });

    server.set("empty_obj", {});
    server.set("empty_arr", []);

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(300);

    // Empty obj/array produces no leaf keys (only .length=0 for array)
    expect(c.get("empty_arr.length")).toBe(0);
    expect(c.data.empty_arr.length).toBe(0);
  });
});

// ════════════════════════════════════════
// 3. Proxy Edge Cases
// ════════════════════════════════════════

describe("Proxy Edge Cases", () => {
  it("undefined access returns undefined", async () => {
    const port = nextPort();
    server = new DanWebSocketServer({ port, mode: "broadcast" });
    server.set("a", 1);

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    expect(c.data.nonexistent).toBeUndefined();
    expect(c.data.a).toBe(1);
  });

  it("filter/find/some/every on array proxy", async () => {
    const port = nextPort();
    server = new DanWebSocketServer({ port, mode: "broadcast" });
    server.set("nums", [1, 2, 3, 4, 5]);

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    const filtered = c.data.nums.filter((n: number) => n > 3);
    expect(filtered).toEqual([4, 5]);

    const found = c.data.nums.find((n: number) => n === 3);
    expect(found).toBe(3);

    expect(c.data.nums.some((n: number) => n === 5)).toBe(true);
    expect(c.data.nums.every((n: number) => n > 0)).toBe(true);
  });

  it("reduce on array proxy", async () => {
    const port = nextPort();
    server = new DanWebSocketServer({ port, mode: "broadcast" });
    server.set("prices", [10, 20, 30]);

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    const sum = c.data.prices.reduce((acc: number, v: number) => acc + v, 0);
    expect(sum).toBe(60);
  });

  it("proxy 'in' operator", async () => {
    const port = nextPort();
    server = new DanWebSocketServer({ port, mode: "broadcast" });
    server.set("obj", { name: "test", value: 42 });

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    expect("name" in c.data.obj).toBe(true);
    expect("missing" in c.data.obj).toBe(false);
  });
});

// ════════════════════════════════════════
// 4. Callback Unsubscribe Verification
// ════════════════════════════════════════

describe("Callback Unsubscribe", () => {
  it("client.onReceive unsubscribe stops callbacks", async () => {
    const port = nextPort();
    server = new DanWebSocketServer({ port, mode: "broadcast" });
    server.set("x", 0);

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    const received: number[] = [];
    const unsub = c.onReceive((key, val) => { if (key === "x") received.push(val as number); });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    server.set("x", 1);
    await waitFor(200);
    expect(received).toContain(1);

    unsub(); // unsubscribe

    server.set("x", 2);
    await waitFor(200);
    expect(received).not.toContain(2);
  });

  it("topic onUpdate unsubscribe", async () => {
    const port = nextPort();
    server = new DanWebSocketServer({ port, mode: "session_topic" });
    let counter = 0;

    server.topic.onSubscribe((session, topic) => {
      topic.setCallback((event, t) => {
        counter++;
        t.payload.set("tick", counter);
      });
      topic.setDelayedTask(50);
    });

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    const updates: number[] = [];
    const unsub = c.topic("ticker").onUpdate((p) => {
      const tick = p.get("tick");
      if (tick !== undefined) updates.push(tick as number);
    });
    c.connect();
    await waitUntil(() => ready);
    c.subscribe("ticker");
    await waitFor(300);

    const countBefore = updates.length;
    expect(countBefore).toBeGreaterThan(0);

    unsub();
    await waitFor(300);

    // No new updates should have been added
    expect(updates.length).toBe(countBefore);
  });
});

// ════════════════════════════════════════
// 5. 4-Byte KeyId Range Tests
// ════════════════════════════════════════

describe("4-Byte KeyId", () => {
  it("handles many keys without collision", async () => {
    const port = nextPort();
    server = new DanWebSocketServer({ port, mode: "broadcast" });

    // Set many objects to generate lots of keyIds
    for (let i = 0; i < 100; i++) {
      server.set(`item${i}`, { value: i, label: `item-${i}` });
    }

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(500);

    // Check a sample
    expect(c.get("item0.value")).toBe(0);
    expect(c.get("item50.value")).toBe(50);
    expect(c.get("item99.label")).toBe("item-99");
    expect(c.keys.length).toBeGreaterThanOrEqual(200); // at least 100 items × 2 keys
  });
});

// ════════════════════════════════════════
// 6. Multi-Client Tests
// ════════════════════════════════════════

describe("Multi-Client", () => {
  it("broadcast: 5 clients all receive same flattened data", async () => {
    const port = nextPort();
    server = new DanWebSocketServer({ port, mode: "broadcast" });
    server.set("shared", { count: 42, items: [1, 2, 3] });

    const readyCount = { n: 0 };
    const clientArr: DanWebSocketClient[] = [];

    for (let i = 0; i < 5; i++) {
      const c = createClient(port);
      clientArr.push(c);
      c.onReady(() => { readyCount.n++; });
      c.connect();
    }

    await waitUntil(() => readyCount.n === 5);
    await waitFor(300);

    for (const c of clientArr) {
      expect(c.get("shared.count")).toBe(42);
      expect(c.get("shared.items.length")).toBe(3);
      expect(c.get("shared.items.2")).toBe(3);
    }
  });

  it("principal: two users get different flattened data", async () => {
    const port = nextPort();
    server = new DanWebSocketServer({ port, mode: "principal" });
    server.enableAuthorization(true);
    server.onAuthorize((uuid, token) => server.authorize(uuid, token, token));

    server.principal("alice").set("profile", { name: "Alice", level: 10 });
    server.principal("bob").set("profile", { name: "Bob", level: 5 });

    const cA = createClient(port);
    const cB = createClient(port);
    let rA = false, rB = false;
    cA.onConnect(() => cA.authorize("alice"));
    cB.onConnect(() => cB.authorize("bob"));
    cA.onReady(() => { rA = true; });
    cB.onReady(() => { rB = true; });
    cA.connect();
    cB.connect();

    await waitUntil(() => rA && rB);
    await waitFor(300);

    expect(cA.get("profile.name")).toBe("Alice");
    expect(cA.get("profile.level")).toBe(10);
    expect(cB.get("profile.name")).toBe("Bob");
    expect(cB.get("profile.level")).toBe(5);
  });
});

// ════════════════════════════════════════
// 7. Flatten + Topic Combination
// ════════════════════════════════════════

describe("Flatten + Topic", () => {
  it("topic payload.set with complex nested object", async () => {
    const port = nextPort();
    server = new DanWebSocketServer({ port, mode: "session_topic" });

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "dashboard") {
        topic.setCallback((event, t) => {
          t.payload.set("stats", {
            cpu: { cores: 8, usage: [10, 20, 30, 40, 50, 60, 70, 80] },
            memory: { total: 16, used: 8.5, cached: 3.2 },
            disks: [
              { name: "/dev/sda", usage: 65 },
              { name: "/dev/sdb", usage: 30 },
            ],
          });
        });
      }
    });

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);

    c.subscribe("dashboard");
    await waitFor(500);

    const topic = c.topic("dashboard");
    expect(topic.get("stats.cpu.cores")).toBe(8);
    expect(topic.get("stats.cpu.usage.length")).toBe(8);
    expect(topic.get("stats.cpu.usage.7")).toBe(80);
    expect(topic.get("stats.memory.used")).toBe(8.5);
    expect(topic.get("stats.disks.length")).toBe(2);
    expect(topic.get("stats.disks.0.name")).toBe("/dev/sda");
    expect(topic.get("stats.disks.1.usage")).toBe(30);

    // Proxy access
    const data = topic.data;
    expect(data.stats.cpu.cores).toBe(8);
    expect(data.stats.disks[0].name).toBe("/dev/sda");
    const usages: number[] = [];
    data.stats.cpu.usage.forEach((u: number) => usages.push(u));
    expect(usages).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
  });

  it("topic payload.set then update with array shrink", async () => {
    const port = nextPort();
    server = new DanWebSocketServer({ port, mode: "session_topic" });
    let callCount = 0;

    server.topic.onSubscribe((session, topic) => {
      topic.setCallback((event, t) => {
        callCount++;
        if (callCount === 1) {
          t.payload.set("items", [{ id: 1 }, { id: 2 }, { id: 3 }]);
        }
      });
    });

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);

    c.subscribe("shrink");
    await waitFor(500);

    expect(c.topic("shrink").get("items.length")).toBe(3);
    expect(c.topic("shrink").get("items.2.id")).toBe(3);

    // Trigger update with smaller array via params change
    server.topic.onSubscribe(() => {}); // no-op, already subscribed
    // Directly access internal to update
    const session = server.getSession(c.id)!;
    const handle = session.getTopicHandle("shrink")!;
    handle.payload.set("items", [{ id: 10 }]);
    await waitFor(500);

    expect(c.topic("shrink").get("items.length")).toBe(1);
    expect(c.topic("shrink").get("items.0.id")).toBe(10);
    expect(c.topic("shrink").get("items.1.id")).toBeUndefined();
    expect(c.topic("shrink").get("items.2.id")).toBeUndefined();
  });

  it("session.set with auto-flatten in topic mode", async () => {
    const port = nextPort();
    server = new DanWebSocketServer({ port, mode: "session_topic" });

    server.topic.onSubscribe((session, topic) => {
      topic.setCallback((event, t, s) => {
        // Use session flat set with object
        s.set("metadata", { source: topic.name, ts: 12345 });
        t.payload.set("data", { value: 42 });
      });
    });

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);

    c.subscribe("test");
    await waitFor(500);

    // Flat session data (auto-flattened)
    expect(c.get("metadata.source")).toBe("test");
    expect(c.get("metadata.ts")).toBe(12345);
    // Topic data
    expect(c.topic("test").get("data.value")).toBe(42);
  });
});

// ════════════════════════════════════════
// 8. Error Resilience
// ════════════════════════════════════════

describe("Error Resilience", () => {
  it("depth 11 throws error", () => {
    const port = nextPort();
    server = new DanWebSocketServer({ port, mode: "broadcast" });
    let obj: any = { x: 1 };
    for (let i = 0; i < 11; i++) obj = { n: obj };
    expect(() => server.set("deep", obj)).toThrow(/depth/i);
  });

  it("circular reference throws error", () => {
    const port = nextPort();
    server = new DanWebSocketServer({ port, mode: "broadcast" });
    const a: any = {};
    const b: any = { a };
    a.b = b;
    expect(() => server.set("circ", a)).toThrow(/circular/i);
  });

  it("array with circular ref throws", () => {
    const port = nextPort();
    server = new DanWebSocketServer({ port, mode: "broadcast" });
    const arr: any[] = [1, 2];
    arr.push(arr);
    expect(() => server.set("circ_arr", arr)).toThrow(/circular/i);
  });

  it("set after clear works correctly", async () => {
    const port = nextPort();
    server = new DanWebSocketServer({ port, mode: "broadcast" });
    server.set("obj", { a: 1, b: 2 });

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    server.clear("obj");
    await waitFor(200);
    expect(c.get("obj.a")).toBeUndefined();

    server.set("obj", { x: 10 });
    await waitFor(300);
    expect(c.get("obj.x")).toBe(10);
    expect(c.get("obj.a")).toBeUndefined();
  });
});

// ════════════════════════════════════════
// 9. Principal Data Persistence (bug fix verification)
// ════════════════════════════════════════

describe("Principal Data Persistence", () => {
  it("data survives after last session disconnects and reconnects", async () => {
    const port = nextPort();
    server = new DanWebSocketServer({ port, mode: "principal", session: { ttl: 100 } });
    server.enableAuthorization(true);
    server.onAuthorize((uuid, token) => server.authorize(uuid, token, token));

    server.principal("alice").set("score", 100);

    // Connect, verify, disconnect
    const c1 = createClient(port);
    let r1 = false;
    c1.onConnect(() => c1.authorize("alice"));
    c1.onReady(() => { r1 = true; });
    c1.connect();
    await waitUntil(() => r1);
    await waitFor(200);
    expect(c1.get("score")).toBe(100);
    c1.disconnect();

    // Wait past TTL
    await waitFor(300);

    // Data should still be in principal store (fix from v0.4.0)
    expect(server.principal("alice").get("score")).toBe(100);

    // Reconnect with new client
    const c2 = createClient(port);
    let r2 = false;
    c2.onConnect(() => c2.authorize("alice"));
    c2.onReady(() => { r2 = true; });
    c2.connect();
    await waitUntil(() => r2);
    await waitFor(200);

    expect(c2.get("score")).toBe(100);
  });
});
