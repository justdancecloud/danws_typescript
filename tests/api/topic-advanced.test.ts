import { describe, it, expect, afterEach } from "vitest";
import { DanWebSocketServer } from "../../src/api/server.js";
import { DanWebSocketClient } from "../../src/api/client.js";
import { EventType } from "../../src/api/topic-handle.js";

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

// ════════════════════════════════════════
// Rapid subscribe / unsubscribe / re-subscribe
// ════════════════════════════════════════

describe("Topic Advanced: Rapid lifecycle", () => {

  it("subscribe → unsubscribe → re-subscribe same topic", async () => {
    server = new DanWebSocketServer({ port: 19400, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    let subscribeCount = 0;
    let unsubscribeCount = 0;

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "data") {
        subscribeCount++;
        topic.setCallback((event, t) => {
          t.payload.set("round", subscribeCount);
        });
      }
    });

    server.topic.onUnsubscribe((session, topic) => {
      if (topic.name === "data") unsubscribeCount++;
    });

    const client = createClient(19400);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    // Round 1
    client.subscribe("data", { v: 1 });
    await waitFor(500);
    expect(client.topic("data").get("round")).toBe(1);

    // Unsubscribe
    client.unsubscribe("data");
    await waitFor(500);
    expect(unsubscribeCount).toBe(1);

    // Round 2 — re-subscribe
    client.subscribe("data", { v: 2 });
    await waitFor(500);
    expect(client.topic("data").get("round")).toBe(2);
    expect(subscribeCount).toBe(2);
  });

  it("rapid setParams multiple times in quick succession", async () => {
    server = new DanWebSocketServer({ port: 19401, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    const receivedPages: number[] = [];

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "list") {
        topic.setCallback((event, t) => {
          const page = t.params.page as number;
          receivedPages.push(page);
          t.payload.set("page", page);
        });
      }
    });

    const client = createClient(19401);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("list", { page: 1 });
    await waitFor(300);

    // Rapid page changes
    client.setParams("list", { page: 2 });
    client.setParams("list", { page: 3 });
    client.setParams("list", { page: 4 });
    await waitFor(800);

    // Should have received the final page at minimum
    expect(receivedPages).toContain(1);
    const lastPage = client.topic("list").get("page") as number;
    expect(lastPage).toBe(4);
  });

  it("subscribe multiple topics simultaneously", async () => {
    server = new DanWebSocketServer({ port: 19402, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    const subscribed: string[] = [];

    server.topic.onSubscribe((session, topic) => {
      subscribed.push(topic.name);
      topic.setCallback((event, t) => {
        t.payload.set("id", t.name);
      });
    });

    const client = createClient(19402);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    // Subscribe to 5 topics at once
    client.subscribe("t1");
    client.subscribe("t2");
    client.subscribe("t3");
    client.subscribe("t4");
    client.subscribe("t5");
    await waitFor(1000);

    expect(subscribed.sort()).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    expect(client.topic("t1").get("id")).toBe("t1");
    expect(client.topic("t5").get("id")).toBe("t5");
  });
});

// ════════════════════════════════════════
// Multiple sessions with different topics
// ════════════════════════════════════════

describe("Topic Advanced: Multi-session isolation", () => {

  it("two clients subscribe to same topic with different params → different data", async () => {
    server = new DanWebSocketServer({ port: 19410, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "feed") {
        topic.setCallback((event, t) => {
          t.payload.set("content", `page-${t.params.page}`);
        });
      }
    });

    const c1 = createClient(19410);
    const c2 = createClient(19410);
    let r1 = false, r2 = false;
    c1.onReady(() => { r1 = true; });
    c2.onReady(() => { r2 = true; });
    c1.connect();
    c2.connect();
    await waitUntil(() => r1 && r2);

    c1.subscribe("feed", { page: 1 });
    c2.subscribe("feed", { page: 99 });
    await waitFor(800);

    expect(c1.topic("feed").get("content")).toBe("page-1");
    expect(c2.topic("feed").get("content")).toBe("page-99");
  });

  it("one client subscribes, another does not — no cross-talk", async () => {
    server = new DanWebSocketServer({ port: 19411, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "secret") {
        topic.setCallback((event, t) => {
          t.payload.set("data", "hidden");
        });
      }
    });

    const c1 = createClient(19411);
    const c2 = createClient(19411);
    let r1 = false, r2 = false;
    c1.onReady(() => { r1 = true; });
    c2.onReady(() => { r2 = true; });
    c1.connect();
    c2.connect();
    await waitUntil(() => r1 && r2);

    c1.subscribe("secret");
    await waitFor(500);

    expect(c1.topic("secret").get("data")).toBe("hidden");
    // c2 never subscribed — should have nothing
    expect(c2.topic("secret").get("data")).toBeUndefined();
  });
});

// ════════════════════════════════════════
// DelayedTask lifecycle edge cases
// ════════════════════════════════════════

describe("Topic Advanced: DelayedTask edge cases", () => {

  it("setDelayedTask without setCallback does nothing (no crash)", async () => {
    server = new DanWebSocketServer({ port: 19420, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "nocrash") {
        // Only set delayed task, no callback
        topic.setDelayedTask(100);
      }
    });

    const client = createClient(19420);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("nocrash");
    await waitFor(500);
    // Should not crash — timer fires but callback is null
  });

  it("delayed task continues after params change with new params", async () => {
    server = new DanWebSocketServer({ port: 19421, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    const allParams: number[] = [];

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "ticker") {
        topic.setCallback((event, t) => {
          allParams.push(t.params.n as number);
          t.payload.set("n", t.params.n as number);
        });
        topic.setDelayedTask(150);
      }
    });

    const client = createClient(19421);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("ticker", { n: 1 });
    await waitFor(400);

    client.setParams("ticker", { n: 2 });
    await waitFor(400);

    // Should have params=1 initially, then params=2 after change
    expect(allParams).toContain(1);
    expect(allParams).toContain(2);
    // Latest value should be 2
    expect(client.topic("ticker").get("n")).toBe(2);
  });

  it("clearDelayedTask mid-polling stops further calls", async () => {
    server = new DanWebSocketServer({ port: 19422, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    let counter = 0;

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "stopper") {
        topic.setCallback((event, t) => {
          counter++;
          t.payload.set("c", counter);
        });
        topic.setDelayedTask(80);

        // Stop after 300ms
        setTimeout(() => topic.clearDelayedTask(), 300);
      }
    });

    const client = createClient(19422);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("stopper");
    await waitFor(800);

    const countAtStop = counter;
    await waitFor(400);

    // Counter should not have increased after stop
    expect(counter).toBe(countAtStop);
  });
});

// ════════════════════════════════════════
// Payload operations
// ════════════════════════════════════════

describe("Topic Advanced: Payload operations", () => {

  it("payload.clear() removes all keys from client", async () => {
    server = new DanWebSocketServer({ port: 19430, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    let shouldClear = false;

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "clearable") {
        topic.setCallback((event, t) => {
          if (shouldClear) {
            t.payload.clear();
          } else {
            t.payload.set("a", 1);
            t.payload.set("b", 2);
            t.payload.set("c", 3);
          }
        });
        topic.setDelayedTask(200);
      }
    });

    const client = createClient(19430);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("clearable");
    await waitFor(500);

    expect(client.topic("clearable").keys.sort()).toEqual(["a", "b", "c"]);

    // Trigger clear on next tick
    shouldClear = true;
    await waitFor(500);

    expect(client.topic("clearable").keys).toEqual([]);
  });

  it("payload.clear(key) removes only one key", async () => {
    server = new DanWebSocketServer({ port: 19431, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    let clearB = false;

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "partial") {
        topic.setCallback((event, t) => {
          if (clearB) {
            t.payload.clear("b");
          } else {
            t.payload.set("a", 10);
            t.payload.set("b", 20);
          }
        });
        topic.setDelayedTask(200);
      }
    });

    const client = createClient(19431);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("partial");
    await waitFor(500);

    expect(client.topic("partial").get("a")).toBe(10);
    expect(client.topic("partial").get("b")).toBe(20);

    clearB = true;
    await waitFor(500);

    expect(client.topic("partial").get("a")).toBe(10);
    expect(client.topic("partial").get("b")).toBeUndefined();
  });

  it("payload handles various data types", async () => {
    server = new DanWebSocketServer({ port: 19432, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "types") {
        topic.setCallback((event, t) => {
          t.payload.set("str", "hello");
          t.payload.set("num", 3.14);
          t.payload.set("bool", true);
          t.payload.set("nil", null);
          t.payload.set("big", 9007199254740993n);
          t.payload.set("date", new Date("2026-01-01T00:00:00Z"));
          t.payload.set("bin", new Uint8Array([0xDE, 0xAD]));
        });
      }
    });

    const client = createClient(19432);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("types");
    await waitFor(800);

    const tp = client.topic("types");
    expect(tp.get("str")).toBe("hello");
    expect(tp.get("num")).toBeCloseTo(3.14);
    expect(tp.get("bool")).toBe(true);
    expect(tp.get("nil")).toBe(null);
    expect(tp.get("big")).toBe(9007199254740993n);
    expect((tp.get("date") as Date).getTime()).toBe(new Date("2026-01-01T00:00:00Z").getTime());
    expect(tp.get("bin")).toEqual(new Uint8Array([0xDE, 0xAD]));
  });
});

// ════════════════════════════════════════
// EventType correctness
// ════════════════════════════════════════

describe("Topic Advanced: EventType sequence", () => {

  it("full event lifecycle: Subscribe → Delayed × N → ParamsChange → Delayed × N → Unsubscribe", async () => {
    server = new DanWebSocketServer({ port: 19440, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    const events: EventType[] = [];
    let unsubscribeCalled = false;

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "lifecycle") {
        topic.setCallback((event, t) => {
          events.push(event);
          t.payload.set("last", event);
        });
        topic.setDelayedTask(100);
      }
    });

    server.topic.onUnsubscribe((session, topic) => {
      if (topic.name === "lifecycle") unsubscribeCalled = true;
    });

    const client = createClient(19440);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    // Subscribe → SubscribeEvent + Delayed ticks
    client.subscribe("lifecycle", { x: 1 });
    await waitFor(350);

    // Params change → ChangedParamsEvent
    client.setParams("lifecycle", { x: 2 });
    await waitFor(350);

    // Unsubscribe
    client.unsubscribe("lifecycle");
    await waitFor(300);

    expect(events[0]).toBe(EventType.SubscribeEvent);
    expect(events.filter(e => e === EventType.DelayedTaskEvent).length).toBeGreaterThanOrEqual(2);
    expect(events).toContain(EventType.ChangedParamsEvent);
    expect(unsubscribeCalled).toBe(true);
  });
});

// ════════════════════════════════════════
// session_principal_topic advanced
// ════════════════════════════════════════

describe("Topic Advanced: session_principal_topic", () => {

  it("two users subscribe to same topic — isolated data + correct principal", async () => {
    server = new DanWebSocketServer({ port: 19450, path: "/ws", mode: "session_principal_topic" });
    await waitFor(50);

    server.enableAuthorization(true);
    server.onAuthorize((uuid, token) => server!.authorize(uuid, token, token));

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "profile") {
        topic.setCallback((event, t, s) => {
          t.payload.set("name", s!.principal!);
          t.payload.set("greeting", `Hello ${s!.principal!}`);
        });
      }
    });

    const c1 = createClient(19450);
    const c2 = createClient(19450);
    c1.onConnect(() => c1.authorize("alice"));
    c2.onConnect(() => c2.authorize("bob"));

    let r1 = false, r2 = false;
    c1.onReady(() => { r1 = true; });
    c2.onReady(() => { r2 = true; });
    c1.connect();
    c2.connect();
    await waitUntil(() => r1 && r2);

    c1.subscribe("profile");
    c2.subscribe("profile");
    await waitFor(800);

    expect(c1.topic("profile").get("name")).toBe("alice");
    expect(c1.topic("profile").get("greeting")).toBe("Hello alice");
    expect(c2.topic("profile").get("name")).toBe("bob");
    expect(c2.topic("profile").get("greeting")).toBe("Hello bob");
  });

  it("principal info available in delayed task callback", async () => {
    server = new DanWebSocketServer({ port: 19451, path: "/ws", mode: "session_principal_topic" });
    await waitFor(50);

    server.enableAuthorization(true);
    server.onAuthorize((uuid, token) => server!.authorize(uuid, token, token));

    const principalsInTask: string[] = [];

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "monitor") {
        topic.setCallback((event, t, s) => {
          principalsInTask.push(s!.principal!);
          t.payload.set("who", s!.principal!);
        });
        topic.setDelayedTask(150);
      }
    });

    const client = createClient(19451);
    client.onConnect(() => client.authorize("carol"));

    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("monitor");
    await waitFor(500);

    // All task calls should have "carol" as principal
    expect(principalsInTask.every(p => p === "carol")).toBe(true);
    expect(principalsInTask.length).toBeGreaterThanOrEqual(2);
  });
});

// ════════════════════════════════════════
// Backward compatibility — session.set still works
// ════════════════════════════════════════

describe("Topic Advanced: Backward compat", () => {

  it("session.set() flat data + topic payload coexist", async () => {
    server = new DanWebSocketServer({ port: 19460, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    // Use old API (session.set) alongside new API (topic.payload.set)
    server.onTopicSubscribe((session, topicInfo) => {
      if (topicInfo.name === "mixed") {
        // Old style — flat session.set
        session.set("flat.key", "flat-value");
      }
    });

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "mixed") {
        // New style — scoped payload
        topic.setCallback((event, t) => {
          t.payload.set("scoped.key", "scoped-value");
        });
      }
    });

    const client = createClient(19460);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("mixed");
    await waitFor(800);

    // Both should be accessible
    expect(client.get("flat.key")).toBe("flat-value");
    expect(client.topic("mixed").get("scoped.key")).toBe("scoped-value");
  });

  it("old onTopicSubscribe + onTopicParamsChange callbacks still fire", async () => {
    server = new DanWebSocketServer({ port: 19461, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    const oldSubscribeNames: string[] = [];
    const oldParamsChangeNames: string[] = [];

    server.onTopicSubscribe((session, topicInfo) => {
      oldSubscribeNames.push(topicInfo.name);
    });

    server.onTopicParamsChange((session, topicInfo) => {
      oldParamsChangeNames.push(topicInfo.name);
    });

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "compat") {
        topic.setCallback((event, t) => {
          t.payload.set("v", 1);
        });
      }
    });

    const client = createClient(19461);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("compat", { a: 1 });
    await waitFor(500);

    client.setParams("compat", { a: 2 });
    await waitFor(500);

    expect(oldSubscribeNames).toContain("compat");
    expect(oldParamsChangeNames).toContain("compat");
  });
});

// ════════════════════════════════════════
// Server close cleanup
// ════════════════════════════════════════

describe("Topic Advanced: Server close", () => {

  it("server.close() disposes all topic handles and timers", async () => {
    server = new DanWebSocketServer({ port: 19470, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    let taskCount = 0;

    server.topic.onSubscribe((session, topic) => {
      if (topic.name === "forever") {
        topic.setCallback((event, t) => {
          taskCount++;
          t.payload.set("c", taskCount);
        });
        topic.setDelayedTask(50);
      }
    });

    const client = createClient(19470);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("forever");
    await waitFor(300);

    const countBeforeClose = taskCount;
    expect(countBeforeClose).toBeGreaterThanOrEqual(3);

    server!.close();
    server = null; // prevent double close in afterEach
    await waitFor(300);

    // Timer should have stopped — count should not increase
    expect(taskCount).toBe(countBeforeClose);
  });
});
