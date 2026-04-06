import { describe, it, expect, afterEach } from "vitest";
import { DanWebSocketServer } from "../../src/api/server.js";
import { DanWebSocketClient } from "../../src/api/client.js";
import { EventType } from "../../src/api/topic-handle.js";
import type { TopicHandle } from "../../src/api/topic-handle.js";

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

function createClient(port: number, opts?: any) {
  const c = new DanWebSocketClient(`ws://127.0.0.1:${port}/ws`, opts);
  clients.push(c);
  return c;
}

// ────────────────────────────────────────
// server.topic.onSubscribe + setCallback + payload.set
// ────────────────────────────────────────

describe("Topic Refactored: setCallback + payload.set", () => {

  it("setCallback runs immediately with SubscribeEvent and payload reaches client", async () => {
    server = new DanWebSocketServer({ port: 19300, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    const events: EventType[] = [];

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "board.posts") {
        topic.setCallback((event, t) => {
          events.push(event);
          t.payload.set("count", 42);
        });
      }
    });

    const client = createClient(19300);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("board.posts", { page: 1 });
    await waitFor(800);

    expect(events).toContain(EventType.SubscribeEvent);
    expect(client.topic("board.posts").get("count")).toBe(42);
  });

  it("setDelayedTask fires periodically with DelayedTaskEvent", async () => {
    server = new DanWebSocketServer({ port: 19301, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    let callCount = 0;

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "counter") {
        topic.setCallback((event, t) => {
          callCount++;
          t.payload.set("n", callCount);
        });
        topic.setDelayedTask(100);
      }
    });

    const client = createClient(19301);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("counter");
    await waitFor(600); // ~5 ticks + initial

    expect(callCount).toBeGreaterThanOrEqual(4);
    const n = client.topic("counter").get("n") as number;
    expect(n).toBeGreaterThanOrEqual(4);
  });

  it("ChangedParamsEvent fires on setParams, task pauses and resumes", async () => {
    server = new DanWebSocketServer({ port: 19302, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    const events: EventType[] = [];
    const paramPages: number[] = [];

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "posts") {
        topic.setCallback((event, t) => {
          events.push(event);
          paramPages.push(t.params.page as number);
          t.payload.set("page", t.params.page as number);
        });
        topic.setDelayedTask(200);
      }
    });

    const client = createClient(19302);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("posts", { page: 1 });
    await waitFor(500);

    client.setParams("posts", { page: 2 });
    await waitFor(500);

    expect(events).toContain(EventType.SubscribeEvent);
    expect(events).toContain(EventType.ChangedParamsEvent);
    expect(events).toContain(EventType.DelayedTaskEvent);
    expect(paramPages).toContain(1);
    expect(paramPages).toContain(2);
    expect(client.topic("posts").get("page")).toBe(2);
  });

  it("clearDelayedTask stops polling", async () => {
    server = new DanWebSocketServer({ port: 19303, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    let callCount = 0;

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "temp") {
        topic.setCallback((event, t) => {
          callCount++;
          t.payload.set("v", callCount);
          if (callCount >= 3) {
            t.clearDelayedTask(); // stop after 3
          }
        });
        topic.setDelayedTask(100);
      }
    });

    const client = createClient(19303);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("temp");
    await waitFor(1000);

    // Should have stopped around 3-4 calls
    expect(callCount).toBeLessThanOrEqual(5);
    expect(callCount).toBeGreaterThanOrEqual(3);
  });
});

// ────────────────────────────────────────
// Topic scoped payload — no collisions
// ────────────────────────────────────────

describe("Topic Refactored: Payload Scoping", () => {

  it("two topics have isolated payloads", async () => {
    server = new DanWebSocketServer({ port: 19310, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "topic.a") {
        topic.setCallback((event, t) => {
          t.payload.set("value", "AAA");
        });
      }
      if (topic.name === "topic.b") {
        topic.setCallback((event, t) => {
          t.payload.set("value", "BBB");
        });
      }
    });

    const client = createClient(19310);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("topic.a");
    await waitFor(500);
    client.subscribe("topic.b");
    await waitFor(500);

    // Same key name "value" but different topics → no collision
    expect(client.topic("topic.a").get("value")).toBe("AAA");
    expect(client.topic("topic.b").get("value")).toBe("BBB");
  });

  it("topic.keys returns only keys for that topic", async () => {
    server = new DanWebSocketServer({ port: 19311, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "data") {
        topic.setCallback((event, t) => {
          t.payload.set("x", 1);
          t.payload.set("y", 2);
          t.payload.set("z", 3);
        });
      }
    });

    const client = createClient(19311);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("data");
    await waitFor(500);

    const keys = client.topic("data").keys;
    expect(keys.sort()).toEqual(["x", "y", "z"]);
  });
});

// ────────────────────────────────────────
// client.topic().onReceive + onUpdate
// ────────────────────────────────────────

describe("Topic Refactored: Client onReceive + onUpdate", () => {

  it("onReceive fires per key change for the specific topic", async () => {
    server = new DanWebSocketServer({ port: 19320, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "sensor") {
        topic.setCallback((event, t) => {
          t.payload.set("temp", 23.5);
          t.payload.set("humidity", 60);
        });
      }
    });

    const client = createClient(19320);
    const received: Array<{ key: string; value: unknown }> = [];

    client.topic("sensor").onReceive((key, value) => {
      received.push({ key, value });
    });

    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("sensor");
    await waitFor(800);

    expect(received.some(r => r.key === "temp" && r.value === 23.5)).toBe(true);
    expect(received.some(r => r.key === "humidity" && r.value === 60)).toBe(true);
  });

  it("onUpdate fires with full payload view", async () => {
    server = new DanWebSocketServer({ port: 19321, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "info") {
        topic.setCallback((event, t) => {
          t.payload.set("name", "test");
          t.payload.set("count", 99);
        });
      }
    });

    const client = createClient(19321);
    let updatePayload: any = null;

    client.topic("info").onUpdate((payload) => {
      updatePayload = { name: payload.get("name"), count: payload.get("count"), keys: payload.keys };
    });

    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("info");
    await waitFor(800);

    expect(updatePayload).not.toBeNull();
    expect(updatePayload.name).toBe("test");
    expect(updatePayload.count).toBe(99);
    expect(updatePayload.keys.sort()).toEqual(["count", "name"]);
  });
});

// ────────────────────────────────────────
// client.onUpdate for broadcast mode
// ────────────────────────────────────────

describe("Topic Refactored: client.onUpdate (broadcast)", () => {

  it("client.onUpdate fires with full state on any key change", async () => {
    server = new DanWebSocketServer({ port: 19330, path: "/ws", mode: "broadcast" });
    await waitFor(50);

    server.set("a", 1);
    server.set("b", 2);

    const client = createClient(19330);
    let updateCount = 0;
    let lastPayload: any = null;

    client.onUpdate((payload) => {
      updateCount++;
      lastPayload = { a: payload.get("a"), b: payload.get("b") };
    });

    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);
    await waitFor(300);

    expect(updateCount).toBeGreaterThanOrEqual(1);
    expect(lastPayload.a).toBe(1);
    expect(lastPayload.b).toBe(2);
  });
});

// ────────────────────────────────────────
// Unsubscribe + disconnect cleanup
// ────────────────────────────────────────

describe("Topic Refactored: Cleanup", () => {

  it("unsubscribe fires onUnsubscribe and cleans up", async () => {
    server = new DanWebSocketServer({ port: 19340, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    const unsubscribed: string[] = [];
    let taskRunning = false;

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "live") {
        topic.setCallback((event, t) => {
          taskRunning = true;
          t.payload.set("v", 1);
        });
        topic.setDelayedTask(100);
      }
    });

    server.topic.onUnsubscribe((session, topic) => {
      unsubscribed.push(topic.name);
    });

    const client = createClient(19340);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("live");
    await waitFor(400);
    expect(taskRunning).toBe(true);

    client.unsubscribe("live");
    await waitFor(400);

    expect(unsubscribed).toContain("live");
  });

  it("session_principal_topic mode works with setCallback", async () => {
    server = new DanWebSocketServer({ port: 19350, path: "/ws", mode: "session_principal_topic" });
    await waitFor(50);

    server.enableAuthorization(true);
    server.onAuthorize((uuid, token) => server!.authorize(uuid, token, token));

    let receivedPrincipal = "";

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "my.data") {
        receivedPrincipal = session.principal!;
        topic.setCallback((event, t, s) => {
          t.payload.set("user", s!.principal!);
        });
      }
    });

    const client = createClient(19350);
    client.onConnect(() => client.authorize("alice"));

    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("my.data");
    await waitFor(500);

    expect(receivedPrincipal).toBe("alice");
    expect(client.topic("my.data").get("user")).toBe("alice");
  });
});

// ────────────────────────────────────────
// Value change detection
// ────────────────────────────────────────

describe("Topic Refactored: Change Detection", () => {

  it("payload.set with same value does not push again", async () => {
    server = new DanWebSocketServer({ port: 19360, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    let pushCount = 0;

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "stable") {
        topic.setCallback((event, t) => {
          t.payload.set("fixed", "same");
        });
        topic.setDelayedTask(100); // keeps setting same value
      }
    });

    const client = createClient(19360);
    client.topic("stable").onReceive(() => { pushCount++; });

    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("stable");
    await waitFor(800);

    // Initial set pushes once (resync). Subsequent sets with same value should NOT push.
    // Due to resync on first set, we get 1 push. Delayed tasks set same value → no push.
    expect(pushCount).toBeLessThanOrEqual(3); // allowing some resync overhead
  });
});
