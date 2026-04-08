import { describe, it, expect, afterEach } from "vitest";
import { DanWebSocketServer } from "../../src/api/server.js";
import { DanWebSocketClient } from "../../src/api/client.js";
import { EventType } from "../../src/api/topic-handle.js";

function waitFor(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function waitUntil(fn: () => boolean, timeout = 5000): Promise<void> {
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

// ══════════════════════════════════════════════════
// ServerKeyDelete — incremental key deletion
// ══════════════════════════════════════════════════

describe("ServerKeyDelete: broadcast clear(key)", () => {
  it("client removes deleted key without full resync", async () => {
    server = new DanWebSocketServer({ port: 19750, path: "/ws", mode: "broadcast" });
    await waitFor(50);

    server.set("keep", "yes");
    server.set("remove", "bye");
    server.set("also_keep", 42);

    const client = createClient(19750);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    expect(client.get("keep")).toBe("yes");
    expect(client.get("remove")).toBe("bye");
    expect(client.get("also_keep")).toBe(42);

    // Track what the client receives
    const deletedKeys: string[] = [];
    client.onReceive((key, value) => {
      if (value === undefined) deletedKeys.push(key);
    });

    server.clear("remove");
    await waitFor(300);

    // "remove" should be gone
    expect(deletedKeys).toContain("remove");
    expect(client.get("remove")).toBeUndefined();
    expect(client.keys).not.toContain("remove");

    // Other keys should still be there
    expect(client.get("keep")).toBe("yes");
    expect(client.get("also_keep")).toBe(42);
  });
});

describe("ServerKeyDelete: flattened object deletion", () => {
  it("clearing a flattened object sends delete per sub-key", async () => {
    server = new DanWebSocketServer({ port: 19751, path: "/ws", mode: "broadcast" });
    await waitFor(50);

    server.set("user", { name: "Alice", age: 30, role: "admin" });
    server.set("other", "data");

    const client = createClient(19751);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    expect(client.get("user.name")).toBe("Alice");
    expect(client.get("user.age")).toBe(30);
    expect(client.get("other")).toBe("data");

    const deletedKeys: string[] = [];
    client.onReceive((key, value) => {
      if (value === undefined) deletedKeys.push(key);
    });

    server.clear("user");
    await waitFor(300);

    // All user sub-keys deleted
    expect(deletedKeys).toContain("user.name");
    expect(deletedKeys).toContain("user.age");
    expect(deletedKeys).toContain("user.role");
    expect(client.keys).not.toContain("user.name");
    expect(client.keys).not.toContain("user.age");

    // Other data untouched
    expect(client.get("other")).toBe("data");
  });
});

describe("ServerKeyDelete: type change is incremental", () => {
  it("changing type from number to string sends delete+register, not full resync", async () => {
    server = new DanWebSocketServer({ port: 19752, path: "/ws", mode: "broadcast" });
    await waitFor(50);

    server.set("value", 42);
    server.set("stable", "unchanged");

    const client = createClient(19752);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    expect(client.get("value")).toBe(42);
    expect(client.get("stable")).toBe("unchanged");

    // Change type: number → string
    server.set("value", "now a string");
    await waitFor(300);

    // Client should have the new value with new type
    expect(client.get("value")).toBe("now a string");
    // Other keys should still be there (no full resync)
    expect(client.get("stable")).toBe("unchanged");
  });
});

describe("ServerKeyDelete: principal mode clear(key)", () => {
  it("principal clear sends incremental delete", async () => {
    server = new DanWebSocketServer({ port: 19753, path: "/ws", mode: "principal" });
    await waitFor(50);

    server.enableAuthorization(true);
    server.onAuthorize((uuid, token) => server!.authorize(uuid, token, "alice"));

    server.principal("alice").set("a", 1);
    server.principal("alice").set("b", 2);
    server.principal("alice").set("c", 3);

    const client = createClient(19753);
    client.onConnect(() => client.authorize("token"));
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    expect(client.get("a")).toBe(1);
    expect(client.get("b")).toBe(2);
    expect(client.get("c")).toBe(3);

    server.principal("alice").clear("b");
    await waitFor(300);

    expect(client.get("a")).toBe(1);
    expect(client.get("b")).toBeUndefined();
    expect(client.get("c")).toBe(3);
  });
});

// ══════════════════════════════════════════════════
// ServerKeyDelete: topic mode
// ══════════════════════════════════════════════════

describe("ServerKeyDelete: topic payload clear(key)", () => {
  it("clearing a topic payload key sends incremental delete", async () => {
    server = new DanWebSocketServer({ port: 19754, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    let callCount = 0;
    server.topic.onSubscribe((session, topic) => {
      topic.setCallback((event, t) => {
        callCount++;
        if (callCount === 1) {
          t.payload.set("items", [1, 2, 3]);
          t.payload.set("count", 3);
        } else if (callCount === 2) {
          // Second call: clear items, keep count
          t.payload.clear("items");
        }
      });
    });

    const client = createClient(19754);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("data");
    await waitFor(600);

    expect(client.topic("data").get("count")).toBe(3);
    expect(client.topic("data").get("items.0")).toBe(1);

    // Trigger second callback manually via setParams
    client.setParams("data", { refresh: true });
    await waitFor(600);

    // items should be cleared, count should remain
    expect(client.topic("data").get("count")).toBe(3);
    expect(client.topic("data").get("items.0")).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════
// KeyId Reuse
// ══════════════════════════════════════════════════

describe("KeyId reuse: deleted keyIds are recycled", () => {
  it("after delete+set, server reuses keyIds", async () => {
    server = new DanWebSocketServer({ port: 19755, path: "/ws", mode: "broadcast" });
    await waitFor(50);

    // Create keys: keyId 1, 2, 3
    server.set("a", 1);
    server.set("b", 2);
    server.set("c", 3);

    const client = createClient(19755);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    // Delete b (frees keyId 2)
    server.clear("b");
    await waitFor(200);

    // Set new key — should reuse freed keyId
    server.set("d", 4);
    await waitFor(300);

    expect(client.get("a")).toBe(1);
    expect(client.get("b")).toBeUndefined();
    expect(client.get("c")).toBe(3);
    expect(client.get("d")).toBe(4);

    // All 3 active keys should work correctly
    expect(client.keys.sort()).toEqual(["a", "c", "d"]);
  });
});

describe("KeyId reuse: repeated delete+create cycle", () => {
  it("100 cycles of delete+create don't exhaust keyIds", async () => {
    server = new DanWebSocketServer({ port: 19756, path: "/ws", mode: "broadcast" });
    await waitFor(50);

    server.set("counter", 0);

    const client = createClient(19756);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    // Rapid delete+create cycle (simulates long-running server)
    for (let i = 0; i < 100; i++) {
      server.clear("counter");
      server.set("counter", i);
    }
    await waitFor(500);

    expect(client.get("counter")).toBe(99);
  });
});

// ══════════════════════════════════════════════════
// ClientKeyRequest — single-key recovery
// ══════════════════════════════════════════════════

describe("ClientKeyRequest: recovery without full resync", () => {
  it("new key added after initial sync is recovered via ClientKeyRequest", async () => {
    server = new DanWebSocketServer({ port: 19757, path: "/ws", mode: "broadcast" });
    await waitFor(50);

    server.set("initial", "data");

    const client = createClient(19757);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    expect(client.get("initial")).toBe("data");

    // Server adds a new key after client is ready
    // This exercises the incremental key registration path
    server.set("new_key", "hello");
    await waitFor(300);

    expect(client.get("new_key")).toBe("hello");
    // Initial data should still be there (not reset)
    expect(client.get("initial")).toBe("data");
  });
});

describe("ClientKeyRequest: topic mode new key after subscribe", () => {
  it("topic payload adding new key after initial sync works", async () => {
    server = new DanWebSocketServer({ port: 19758, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    let callCount = 0;
    server.topic.onSubscribe((session, topic) => {
      topic.setCallback((event, t) => {
        callCount++;
        t.payload.set("base", "always");
        if (callCount > 1) {
          // Add new key on subsequent calls
          t.payload.set("extra", "added later");
        }
      });
      topic.setDelayedTask(200);
    });

    const client = createClient(19758);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("feed");
    await waitFor(800);

    expect(client.topic("feed").get("base")).toBe("always");
    expect(client.topic("feed").get("extra")).toBe("added later");
  });
});

// ══════════════════════════════════════════════════
// Combined: delete + add in same session
// ══════════════════════════════════════════════════

describe("Combined: delete old keys, add new keys", () => {
  it("replacing an entire object structure works incrementally", async () => {
    server = new DanWebSocketServer({ port: 19759, path: "/ws", mode: "broadcast" });
    await waitFor(50);

    server.set("config", { host: "localhost", port: 8080, debug: true });

    const client = createClient(19759);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    expect(client.get("config.host")).toBe("localhost");
    expect(client.get("config.port")).toBe(8080);
    expect(client.get("config.debug")).toBe(true);

    // Replace with different structure
    server.set("config", { host: "production.example.com", ssl: true, timeout: 30000 });
    await waitFor(400);

    // New keys
    expect(client.get("config.host")).toBe("production.example.com");
    expect(client.get("config.ssl")).toBe(true);
    expect(client.get("config.timeout")).toBe(30000);

    // Old keys that were removed
    expect(client.get("config.port")).toBeUndefined();
    expect(client.get("config.debug")).toBeUndefined();
  });
});
