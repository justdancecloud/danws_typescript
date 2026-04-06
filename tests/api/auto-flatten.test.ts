import { describe, it, expect, afterEach } from "vitest";
import { DanWebSocketServer } from "../../src/api/server.js";
import { DanWebSocketClient } from "../../src/api/client.js";

const BASE_PORT = 19700;
let portCounter = 0;
function nextPort(): number { return BASE_PORT + portCounter++; }

function waitFor(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
function waitUntil(fn: () => boolean, timeout = 3000): Promise<void> {
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
const clients: DanWebSocketClient[] = [];

function createServer(port: number, mode: any = "broadcast") {
  server = new DanWebSocketServer({ port, mode });
  return server;
}

function createClient(port: number) {
  const c = new DanWebSocketClient(`ws://127.0.0.1:${port}`, { reconnect: { enabled: false } });
  clients.push(c);
  return c;
}

afterEach(async () => {
  for (const c of clients) { try { c.disconnect(); } catch {} }
  clients.length = 0;
  if (server) { server.close(); server = null; }
  await waitFor(50);
});

// ═══════════════════════════════
// Server-side auto-flatten tests
// ═══════════════════════════════

describe("Auto-Flatten: Broadcast mode", () => {
  it("simple object flatten", async () => {
    const port = nextPort();
    const s = createServer(port);
    s.set("user", { name: "Alice", age: 30 });

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    expect(c.get("user.name")).toBe("Alice");
    expect(c.get("user.age")).toBe(30);
  });

  it("nested object flatten (2-3 depth)", async () => {
    const port = nextPort();
    const s = createServer(port);
    s.set("config", {
      db: { host: "localhost", port: 5432 },
      cache: { enabled: true },
    });

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    expect(c.get("config.db.host")).toBe("localhost");
    expect(c.get("config.db.port")).toBe(5432);
    expect(c.get("config.cache.enabled")).toBe(true);
  });

  it("array flatten with .length", async () => {
    const port = nextPort();
    const s = createServer(port);
    s.set("scores", [10, 20, 30]);

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    expect(c.get("scores.length")).toBe(3);
    expect(c.get("scores.0")).toBe(10);
    expect(c.get("scores.1")).toBe(20);
    expect(c.get("scores.2")).toBe(30);
  });

  it("array shrink cleans up leftover keys", async () => {
    const port = nextPort();
    const s = createServer(port);
    s.set("items", [1, 2, 3]);

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    expect(c.get("items.length")).toBe(3);
    expect(c.get("items.2")).toBe(3);

    // Shrink array
    s.set("items", [10, 20]);
    await waitFor(300);

    expect(c.get("items.length")).toBe(2);
    expect(c.get("items.0")).toBe(10);
    expect(c.get("items.1")).toBe(20);
    expect(c.get("items.2")).toBeUndefined(); // cleaned up
  });

  it("mixed: object with arrays, array with objects", async () => {
    const port = nextPort();
    const s = createServer(port);
    s.set("data", {
      users: [
        { name: "Alice", scores: [100, 200] },
        { name: "Bob", scores: [50] },
      ],
      meta: { total: 2 },
    });

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    expect(c.get("data.users.length")).toBe(2);
    expect(c.get("data.users.0.name")).toBe("Alice");
    expect(c.get("data.users.0.scores.length")).toBe(2);
    expect(c.get("data.users.0.scores.0")).toBe(100);
    expect(c.get("data.users.1.name")).toBe("Bob");
    expect(c.get("data.users.1.scores.length")).toBe(1);
    expect(c.get("data.meta.total")).toBe(2);
  });

  it("primitive values work unchanged", async () => {
    const port = nextPort();
    const s = createServer(port);
    s.set("count", 42);
    s.set("name", "hello");
    s.set("active", true);

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    expect(c.get("count")).toBe(42);
    expect(c.get("name")).toBe("hello");
    expect(c.get("active")).toBe(true);
  });
});

describe("Auto-Flatten: Error cases", () => {
  it("depth limit exceeded", () => {
    const port = nextPort();
    const s = createServer(port);
    // Build 11-deep nested object
    let obj: any = { leaf: "x" };
    for (let i = 0; i < 11; i++) obj = { nested: obj };
    expect(() => s.set("deep", obj)).toThrow(/depth limit/i);
  });

  it("circular reference detected", () => {
    const port = nextPort();
    const s = createServer(port);
    const a: any = { b: null };
    a.b = a; // circular
    expect(() => s.set("circular", a)).toThrow(/circular/i);
  });
});

// ═══════════════════════════════
// Client-side Proxy tests
// ═══════════════════════════════

describe("Client Proxy: data accessor", () => {
  it("nested object access via Proxy", async () => {
    const port = nextPort();
    const s = createServer(port);
    s.set("dashboard", {
      cpu: 72.5,
      memory: { used: 8.2, total: 16 },
    });

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    const data = c.data;
    expect(data.dashboard.cpu).toBe(72.5);
    expect(data.dashboard.memory.used).toBe(8.2);
    expect(data.dashboard.memory.total).toBe(16);
  });

  it("array index access and iteration", async () => {
    const port = nextPort();
    const s = createServer(port);
    s.set("items", ["apple", "banana", "cherry"]);

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    const data = c.data;
    expect(data.items[0]).toBe("apple");
    expect(data.items[1]).toBe("banana");
    expect(data.items.length).toBe(3);
  });

  it("forEach on array via Proxy", async () => {
    const port = nextPort();
    const s = createServer(port);
    s.set("nums", [10, 20, 30]);

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    const collected: number[] = [];
    c.data.nums.forEach((n: number) => collected.push(n));
    expect(collected).toEqual([10, 20, 30]);
  });

  it("map on array via Proxy", async () => {
    const port = nextPort();
    const s = createServer(port);
    s.set("vals", [1, 2, 3]);

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    const doubled = c.data.vals.map((v: number) => v * 2);
    expect(doubled).toEqual([2, 4, 6]);
  });

  it("array of objects — forEach with nested access", async () => {
    const port = nextPort();
    const s = createServer(port);
    s.set("processes", [
      { pid: 1234, name: "node", cpu: 12.3 },
      { pid: 5678, name: "nginx", cpu: 3.1 },
    ]);

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    const names: string[] = [];
    c.data.processes.forEach((p: any) => names.push(p.name));
    expect(names).toEqual(["node", "nginx"]);
    expect(c.data.processes[0].pid).toBe(1234);
    expect(c.data.processes[1].cpu).toBe(3.1);
  });

  it("for...of iteration on array Proxy", async () => {
    const port = nextPort();
    const s = createServer(port);
    s.set("tags", ["a", "b", "c"]);

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    const items: string[] = [];
    for (const tag of c.data.tags) {
      items.push(tag);
    }
    expect(items).toEqual(["a", "b", "c"]);
  });
});

describe("Auto-Flatten: Topic mode", () => {
  it("topic payload.set() with object auto-flatten", async () => {
    const port = nextPort();
    const s = createServer(port, "session_topic");

    s.topic.onSubscribe((session, topic) => {
      topic.setCallback((event, t) => {
        t.payload.set("result", {
          items: [{ title: "Post 1" }, { title: "Post 2" }],
          total: 2,
        });
      });
    });

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);

    c.subscribe("board");
    await waitFor(500);

    const topic = c.topic("board");
    expect(topic.get("result.total")).toBe(2);
    expect(topic.get("result.items.length")).toBe(2);
    expect(topic.get("result.items.0.title")).toBe("Post 1");
    expect(topic.get("result.items.1.title")).toBe("Post 2");

    // Proxy access
    const data = topic.data;
    expect(data.result.total).toBe(2);
    expect(data.result.items[0].title).toBe("Post 1");

    const titles: string[] = [];
    data.result.items.forEach((item: any) => titles.push(item.title));
    expect(titles).toEqual(["Post 1", "Post 2"]);
  });
});

describe("Client onUpdate Proxy", () => {
  it("onUpdate receives Proxy with nested access", async () => {
    const port = nextPort();
    const s = createServer(port);
    s.set("server", { status: "online", load: 0.5 });

    const c = createClient(port);
    let ready = false;
    let lastState: any = null;
    c.onReady(() => { ready = true; });
    c.onUpdate((state) => { lastState = state; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    expect(lastState).not.toBeNull();
    expect(lastState.server.status).toBe("online");
    expect(lastState.server.load).toBe(0.5);
    // Backward compat
    expect(lastState.get("server.status")).toBe("online");
  });
});
