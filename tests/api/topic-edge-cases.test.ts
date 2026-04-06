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

// ════════════════════════════════════════
// Callback error handling
// ════════════════════════════════════════

describe("Edge: Callback error resilience", () => {

  it("callback throwing does not crash server", async () => {
    server = new DanWebSocketServer({ port: 19500, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    let callCount = 0;

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "crashy") {
        topic.setCallback((event, t) => {
          callCount++;
          if (callCount === 1) throw new Error("BOOM");
          t.payload.set("v", callCount);
        });
        topic.setDelayedTask(100);
      }
    });

    const client = createClient(19500);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("crashy");
    await waitFor(600);

    // First call threw, but subsequent calls should continue
    expect(callCount).toBeGreaterThanOrEqual(3);
    expect(client.topic("crashy").get("v")).toBeGreaterThanOrEqual(2);
  });

  it("async callback rejection does not crash server", async () => {
    server = new DanWebSocketServer({ port: 19501, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    let callCount = 0;

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "async.crash") {
        topic.setCallback(async (event, t) => {
          callCount++;
          if (callCount === 1) throw new Error("ASYNC BOOM");
          t.payload.set("v", callCount);
        });
        topic.setDelayedTask(100);
      }
    });

    const client = createClient(19501);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("async.crash");
    await waitFor(600);

    expect(callCount).toBeGreaterThanOrEqual(3);
  });
});

// ════════════════════════════════════════
// Same params — no event
// ════════════════════════════════════════

describe("Edge: Duplicate params change", () => {

  it("setParams with identical params does not fire ChangedParamsEvent", async () => {
    server = new DanWebSocketServer({ port: 19510, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    const events: EventType[] = [];

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "nodup") {
        topic.setCallback((event, t) => {
          events.push(event);
          t.payload.set("e", event);
        });
      }
    });

    const client = createClient(19510);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("nodup", { page: 1 });
    await waitFor(500);

    // Set same params again
    client.setParams("nodup", { page: 1 });
    await waitFor(500);

    // ChangedParamsEvent should NOT fire since params are identical
    const changedCount = events.filter(e => e === EventType.ChangedParamsEvent).length;
    expect(changedCount).toBe(0);
  });
});

// ════════════════════════════════════════
// Unsubscribe non-existent topic
// ════════════════════════════════════════

describe("Edge: Invalid operations", () => {

  it("unsubscribe non-existent topic does not crash", async () => {
    server = new DanWebSocketServer({ port: 19520, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    const client = createClient(19520);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    // Should not throw
    client.unsubscribe("nonexistent");
    await waitFor(200);
  });

  it("setParams on non-subscribed topic is ignored", async () => {
    server = new DanWebSocketServer({ port: 19521, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    const client = createClient(19521);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    // Should not throw
    client.setParams("nonexistent", { page: 1 });
    await waitFor(200);
  });

  it("topic().get() on non-subscribed topic returns undefined", async () => {
    server = new DanWebSocketServer({ port: 19522, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    const client = createClient(19522);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    expect(client.topic("nope").get("anything")).toBeUndefined();
    expect(client.topic("nope").keys).toEqual([]);
  });
});

// ════════════════════════════════════════
// Subscribe before connect / before ready
// ════════════════════════════════════════

describe("Edge: Subscribe timing", () => {

  it("subscribe before connect — sends after ready", async () => {
    server = new DanWebSocketServer({ port: 19530, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    const subscribed: string[] = [];
    server.topic.onSubscribe((session, topic) => {
      subscribed.push(topic.name);
      topic.setCallback((event, t) => {
        t.payload.set("ok", true);
      });
    });

    const client = createClient(19530);

    // Subscribe BEFORE connect
    client.subscribe("early.bird", { x: 1 });

    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);
    await waitFor(800);

    expect(subscribed).toContain("early.bird");
    expect(client.topic("early.bird").get("ok")).toBe(true);
  });

  it("subscribe in onConnect (before onReady) works", async () => {
    server = new DanWebSocketServer({ port: 19531, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    const subscribed: string[] = [];
    server.topic.onSubscribe((session, topic) => {
      subscribed.push(topic.name);
      topic.setCallback((event, t) => {
        t.payload.set("v", 1);
      });
    });

    const client = createClient(19531);
    client.onConnect(() => {
      client.subscribe("on.connect.topic");
    });

    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);
    await waitFor(800);

    expect(subscribed).toContain("on.connect.topic");
  });
});

// ════════════════════════════════════════
// Payload type change triggers resync
// ════════════════════════════════════════

describe("Edge: Payload type change", () => {

  it("changing value type for same key triggers resync", async () => {
    server = new DanWebSocketServer({ port: 19540, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    let round = 0;

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "typechange") {
        topic.setCallback((event, t) => {
          round++;
          if (round <= 2) {
            t.payload.set("val", "string-value"); // String
          } else {
            t.payload.set("val", 42); // now Float64 — type change!
          }
        });
        topic.setDelayedTask(150);
      }
    });

    const client = createClient(19540);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("typechange");
    await waitFor(800);

    // Should have the number value after type change
    const val = client.topic("typechange").get("val");
    expect(val).toBe(42);
  });
});

// ════════════════════════════════════════
// Multiple listeners
// ════════════════════════════════════════

describe("Edge: Multiple listeners", () => {

  it("multiple onReceive callbacks all fire", async () => {
    server = new DanWebSocketServer({ port: 19550, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "multi") {
        topic.setCallback((event, t) => {
          t.payload.set("x", 10);
        });
      }
    });

    const client = createClient(19550);
    const log1: string[] = [];
    const log2: string[] = [];

    client.topic("multi").onReceive((key, value) => { log1.push(`${key}=${value}`); });
    client.topic("multi").onReceive((key, value) => { log2.push(`${key}=${value}`); });

    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("multi");
    await waitFor(800);

    expect(log1).toContain("x=10");
    expect(log2).toContain("x=10");
  });

  it("multiple onUpdate callbacks all fire", async () => {
    server = new DanWebSocketServer({ port: 19551, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "multi2") {
        topic.setCallback((event, t) => {
          t.payload.set("y", 20);
        });
      }
    });

    const client = createClient(19551);
    let count1 = 0, count2 = 0;

    client.topic("multi2").onUpdate(() => { count1++; });
    client.topic("multi2").onUpdate(() => { count2++; });

    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("multi2");
    await waitFor(800);

    expect(count1).toBeGreaterThanOrEqual(1);
    expect(count2).toBeGreaterThanOrEqual(1);
    expect(count1).toBe(count2);
  });
});

// ════════════════════════════════════════
// Session TTL expiry cleanup
// ════════════════════════════════════════

describe("Edge: Session TTL expiry", () => {

  it("session expiry disposes topic handles", async () => {
    server = new DanWebSocketServer({ port: 19560, path: "/ws", mode: "session_topic", session: { ttl: 200 } });
    await waitFor(50);

    let taskCount = 0;

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "expiry") {
        topic.setCallback((event, t) => {
          taskCount++;
          t.payload.set("c", taskCount);
        });
        topic.setDelayedTask(50);
      }
    });

    const client = createClient(19560, { reconnect: { enabled: false } });
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("expiry");
    await waitFor(300);

    expect(taskCount).toBeGreaterThanOrEqual(3);

    // Disconnect — topic handles should be disposed on disconnect
    client.disconnect();
    await waitFor(100); // small buffer for in-flight timer to settle
    const countAfterDisconnect = taskCount;

    await waitFor(400); // wait well past timer interval

    // No new ticks should fire after disposal settled
    expect(taskCount).toBe(countAfterDisconnect);
  });
});

// ════════════════════════════════════════
// Topic names with dots and underscores
// ════════════════════════════════════════

describe("Edge: Topic name patterns", () => {

  it("topic names with dots work correctly", async () => {
    server = new DanWebSocketServer({ port: 19570, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "com.example.board.posts") {
        topic.setCallback((event, t) => {
          t.payload.set("status", "ok");
        });
      }
    });

    const client = createClient(19570);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("com.example.board.posts");
    await waitFor(500);

    expect(client.topic("com.example.board.posts").get("status")).toBe("ok");
  });

  it("topic names with underscores and numbers", async () => {
    server = new DanWebSocketServer({ port: 19571, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "sensor_v2_floor3") {
        topic.setCallback((event, t) => {
          t.payload.set("temp", 21.5);
        });
      }
    });

    const client = createClient(19571);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("sensor_v2_floor3");
    await waitFor(500);

    expect(client.topic("sensor_v2_floor3").get("temp")).toBe(21.5);
  });
});

// ════════════════════════════════════════
// Topic with empty params
// ════════════════════════════════════════

describe("Edge: Empty and no params", () => {

  it("subscribe with no params argument", async () => {
    server = new DanWebSocketServer({ port: 19580, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    let receivedParams: Record<string, unknown> | null = null;

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "noparam") {
        receivedParams = { ...topic.params };
        topic.setCallback((event, t) => {
          t.payload.set("ok", true);
        });
      }
    });

    const client = createClient(19580);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("noparam"); // no params
    await waitFor(500);

    expect(receivedParams).toEqual({});
    expect(client.topic("noparam").get("ok")).toBe(true);
  });

  it("subscribe with empty params object", async () => {
    server = new DanWebSocketServer({ port: 19581, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    let receivedParams: Record<string, unknown> | null = null;

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "empty") {
        receivedParams = { ...topic.params };
        topic.setCallback((event, t) => {
          t.payload.set("ok", true);
        });
      }
    });

    const client = createClient(19581);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("empty", {});
    await waitFor(500);

    expect(receivedParams).toEqual({});
  });
});

// ════════════════════════════════════════
// High key count stress
// ════════════════════════════════════════

describe("Edge: Stress", () => {

  it("payload with many keys", async () => {
    server = new DanWebSocketServer({ port: 19590, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "bulk") {
        topic.setCallback((event, t) => {
          for (let i = 0; i < 50; i++) {
            t.payload.set(`key${i}`, i * 10);
          }
        });
      }
    });

    const client = createClient(19590);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("bulk");
    await waitFor(800);

    expect(client.topic("bulk").keys.length).toBe(50);
    expect(client.topic("bulk").get("key0")).toBe(0);
    expect(client.topic("bulk").get("key49")).toBe(490);
  });
});
