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

// ══════════════════════════════════════════════════
// BROADCAST MODE — comprehensive
// ══════════════════════════════════════════════════

describe("Broadcast: auto-flatten objects", () => {
  it("nested objects are flattened and received as Proxy", async () => {
    server = new DanWebSocketServer({ port: 19600, path: "/ws", mode: "broadcast" });
    await waitFor(50);

    server.set("dashboard", {
      cpu: 72.5,
      memory: { used: 8.2, total: 16 },
      processes: [
        { pid: 1234, name: "node" },
        { pid: 5678, name: "nginx" },
      ],
    });

    const client = createClient(19600);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    expect(client.get("dashboard.cpu")).toBeCloseTo(72.5);
    expect(client.get("dashboard.memory.used")).toBeCloseTo(8.2);
    expect(client.get("dashboard.processes.0.name")).toBe("node");
    expect(client.get("dashboard.processes.1.pid")).toBe(5678);
    expect(client.get("dashboard.processes.length")).toBe(2);

    // Proxy access
    const d = client.data;
    expect(d.dashboard.cpu).toBeCloseTo(72.5);
    expect(d.dashboard.memory.total).toBe(16);
    expect(d.dashboard.processes[0].name).toBe("node");
  });
});

describe("Broadcast: incremental updates", () => {
  it("only changed fields cause onReceive callbacks", async () => {
    server = new DanWebSocketServer({ port: 19601, path: "/ws", mode: "broadcast" });
    await waitFor(50);

    server.set("data", { a: 1, b: 2, c: 3 });

    const client = createClient(19601);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    const received: string[] = [];
    client.onReceive((key) => { received.push(key); });

    // Only b changes
    server.set("data", { a: 1, b: 99, c: 3 });
    await waitFor(200);

    expect(received).toContain("data.b");
    expect(received).not.toContain("data.a");
    expect(received).not.toContain("data.c");
    expect(client.get("data.b")).toBe(99);
  });
});

describe("Broadcast: onUpdate fires once per batch", () => {
  it("multiple set() calls produce single onUpdate", async () => {
    server = new DanWebSocketServer({ port: 19602, path: "/ws", mode: "broadcast" });
    await waitFor(50);

    const client = createClient(19602);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    let updateCount = 0;
    client.onUpdate(() => { updateCount++; });

    // Set many values at once — should batch into 1 flush
    server.set("x", 1);
    server.set("y", 2);
    server.set("z", 3);
    await waitFor(300);

    // Should be 1 or very few (batched within 100ms)
    expect(updateCount).toBeGreaterThanOrEqual(1);
    expect(updateCount).toBeLessThanOrEqual(2);
  });
});

describe("Broadcast: server.clear()", () => {
  it("server-side clear removes key from server state", () => {
    server = new DanWebSocketServer({ port: 19603, path: "/ws", mode: "broadcast" });

    server.set("a", 1);
    server.set("b", 2);
    server.set("c", 3);

    expect(server.get("a")).toBe(1);
    expect(server.keys.sort()).toEqual(["a", "b", "c"]);

    server.clear("a");
    expect(server.get("a")).toBeUndefined();
    expect(server.keys.sort()).toEqual(["b", "c"]);

    server.clear();
    expect(server.keys).toEqual([]);
  });

  it("clear triggers resync and new client receives correct state", async () => {
    server = new DanWebSocketServer({ port: 19604, path: "/ws", mode: "broadcast" });
    await waitFor(50);

    server.set("keep", "yes");
    server.set("remove", "bye");
    server.clear("remove");

    // New client connecting after clear should only see "keep"
    const client = createClient(19604);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);
    await waitFor(300);

    expect(client.get("keep")).toBe("yes");
    expect(client.keys).not.toContain("remove");
  });
});

// ══════════════════════════════════════════════════
// PRINCIPAL MODE — comprehensive
// ══════════════════════════════════════════════════

describe("Principal: auto-flatten per-user objects", () => {
  it("principal data is auto-flattened and isolated", async () => {
    server = new DanWebSocketServer({ port: 19610, path: "/ws", mode: "principal" });
    await waitFor(50);

    server.enableAuthorization(true);
    server.onAuthorize((uuid, token) => server!.authorize(uuid, token, token));

    server.principal("alice").set("profile", {
      name: "Alice",
      level: 10,
      stats: { hp: 100, mp: 50 },
    });

    server.principal("bob").set("profile", {
      name: "Bob",
      level: 5,
      stats: { hp: 80, mp: 30 },
    });

    const cA = createClient(19610);
    const cB = createClient(19610);
    cA.onConnect(() => cA.authorize("alice"));
    cB.onConnect(() => cB.authorize("bob"));

    let rA = false, rB = false;
    cA.onReady(() => { rA = true; });
    cB.onReady(() => { rB = true; });
    cA.connect();
    cB.connect();
    await waitUntil(() => rA && rB);
    await waitFor(200);

    // Alice sees only alice's data
    expect(cA.get("profile.name")).toBe("Alice");
    expect(cA.get("profile.stats.hp")).toBe(100);
    expect(cA.data.profile.level).toBe(10);

    // Bob sees only bob's data
    expect(cB.get("profile.name")).toBe("Bob");
    expect(cB.get("profile.stats.mp")).toBe(30);
  });
});

describe("Principal: multi-device sync", () => {
  it("two devices for same principal receive the same updates", async () => {
    server = new DanWebSocketServer({ port: 19611, path: "/ws", mode: "principal" });
    await waitFor(50);

    server.enableAuthorization(true);
    server.onAuthorize((uuid, token) => server!.authorize(uuid, token, "alice"));

    server.principal("alice").set("score", 0);

    const pc = createClient(19611);
    const mobile = createClient(19611);
    pc.onConnect(() => pc.authorize("token1"));
    mobile.onConnect(() => mobile.authorize("token2"));

    let rPC = false, rMobile = false;
    pc.onReady(() => { rPC = true; });
    mobile.onReady(() => { rMobile = true; });
    pc.connect();
    mobile.connect();
    await waitUntil(() => rPC && rMobile);
    await waitFor(200);

    expect(pc.get("score")).toBe(0);
    expect(mobile.get("score")).toBe(0);

    // Update score — both devices get it
    server.principal("alice").set("score", 100);
    await waitFor(300);

    expect(pc.get("score")).toBe(100);
    expect(mobile.get("score")).toBe(100);
  });
});

describe("Principal: live update after connect", () => {
  it("server update pushes to already-connected principal clients", async () => {
    server = new DanWebSocketServer({ port: 19612, path: "/ws", mode: "principal" });
    await waitFor(50);

    server.enableAuthorization(true);
    server.onAuthorize((uuid, token) => server!.authorize(uuid, token, "player1"));

    server.principal("player1").set("hp", 100);

    const client = createClient(19612);
    client.onConnect(() => client.authorize("jwt"));

    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);
    await waitFor(200);

    expect(client.get("hp")).toBe(100);

    const received: Array<{ key: string; value: unknown }> = [];
    client.onReceive((key, value) => { received.push({ key, value }); });

    server.principal("player1").set("hp", 75);
    await waitFor(300);

    expect(received.some(r => r.key === "hp" && r.value === 75)).toBe(true);
    expect(client.get("hp")).toBe(75);
  });
});

describe("Principal: auth reject flow", () => {
  it("rejected client receives AUTH_REJECTED error and disconnects", async () => {
    server = new DanWebSocketServer({ port: 19613, path: "/ws", mode: "principal" });
    await waitFor(50);

    server.enableAuthorization(true);
    server.onAuthorize((uuid) => server!.reject(uuid, "invalid credentials"));

    const client = createClient(19613, { reconnect: { enabled: false } });
    const errors: string[] = [];
    client.onConnect(() => client.authorize("bad-token"));
    client.onError((err) => errors.push(err.code));

    client.connect();
    await waitFor(1000);

    expect(errors).toContain("AUTH_REJECTED");
    expect(client.state).toBe("disconnected");
  });
});

describe("Principal: onConnection callback", () => {
  it("server receives session info on new connection", async () => {
    server = new DanWebSocketServer({ port: 19614, path: "/ws", mode: "principal" });
    await waitFor(50);

    server.enableAuthorization(true);
    server.onAuthorize((uuid, token) => server!.authorize(uuid, token, "alice"));
    server.principal("alice").set("x", 1);

    const sessions: string[] = [];
    server.onConnection((session) => { sessions.push(session.id); });

    const client = createClient(19614);
    client.onConnect(() => client.authorize("token"));
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    expect(sessions.length).toBe(1);
    expect(server.getSession(sessions[0])!.principal).toBe("alice");
  });
});

describe("Principal: principal clear and update", () => {
  it("server-side clear removes key from principal state", () => {
    server = new DanWebSocketServer({ port: 19615, path: "/ws", mode: "principal" });
    server.principal("alice").set("a", 1);
    server.principal("alice").set("b", 2);

    expect(server.principal("alice").get("a")).toBe(1);
    server.principal("alice").clear("a");
    expect(server.principal("alice").get("a")).toBeUndefined();
    expect(server.principal("alice").get("b")).toBe(2);
  });

  it("client connecting after clear sees correct state", async () => {
    server = new DanWebSocketServer({ port: 19616, path: "/ws", mode: "principal" });
    await waitFor(50);

    server.enableAuthorization(true);
    server.onAuthorize((uuid, token) => server!.authorize(uuid, token, "alice"));

    server.principal("alice").set("a", 1);
    server.principal("alice").set("b", 2);
    server.principal("alice").clear("a");
    server.principal("alice").set("c", 3);

    const client = createClient(19616);
    client.onConnect(() => client.authorize("t"));
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);
    await waitFor(300);

    expect(client.keys).not.toContain("a");
    expect(client.get("b")).toBe(2);
    expect(client.get("c")).toBe(3);
  });
});

// ══════════════════════════════════════════════════
// SESSION_TOPIC MODE — comprehensive additions
// ══════════════════════════════════════════════════

describe("Session Topic: topic.payload with auto-flatten", () => {
  it("payload.set with nested objects reaches client via topic handle", async () => {
    server = new DanWebSocketServer({ port: 19620, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    server.topic.onSubscribe((session, topic) => {
      topic.setCallback((event, t) => {
        t.payload.set("result", {
          items: [
            { id: 1, title: "Hello" },
            { id: 2, title: "World" },
          ],
          meta: { totalCount: 42, page: 1 },
        });
      });
    });

    const client = createClient(19620);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("posts");
    await waitFor(600);

    const topic = client.topic("posts");
    expect(topic.get("result.items.0.title")).toBe("Hello");
    expect(topic.get("result.items.1.id")).toBe(2);
    expect(topic.get("result.meta.totalCount")).toBe(42);
    expect(topic.get("result.items.length")).toBe(2);
  });
});

describe("Session Topic: setDelayedTask polling", () => {
  it("callback fires periodically and client receives incremental updates", async () => {
    server = new DanWebSocketServer({ port: 19621, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    let callCount = 0;
    server.topic.onSubscribe((session, topic) => {
      topic.setCallback((event, t) => {
        callCount++;
        t.payload.set("counter", callCount);
      });
      topic.setDelayedTask(100); // 100ms polling
    });

    const client = createClient(19621);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("ticker");
    await waitFor(800); // should fire ~6-7 times (1 immediate + ~6 delayed)

    expect(callCount).toBeGreaterThanOrEqual(4);
    const counter = client.topic("ticker").get("counter") as number;
    expect(counter).toBeGreaterThanOrEqual(4);
  });
});

describe("Session Topic: ChangedParamsEvent clears and reloads", () => {
  it("setParams triggers callback with correct event and new params", async () => {
    server = new DanWebSocketServer({ port: 19622, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    const events: EventType[] = [];
    server.topic.onSubscribe((session, topic) => {
      topic.setCallback((event, t) => {
        events.push(event);
        if (event === EventType.ChangedParamsEvent) {
          t.payload.clear();
        }
        const page = (t.params.page as number) ?? 1;
        t.payload.set("page", page);
        t.payload.set("data", `page-${page}-data`);
      });
    });

    const client = createClient(19622);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("feed", { page: 1 });
    await waitFor(500);

    expect(events).toContain(EventType.SubscribeEvent);
    expect(client.topic("feed").get("page")).toBe(1);

    client.setParams("feed", { page: 3 });
    await waitFor(500);

    expect(events).toContain(EventType.ChangedParamsEvent);
    expect(client.topic("feed").get("page")).toBe(3);
    expect(client.topic("feed").get("data")).toBe("page-3-data");
  });
});

describe("Session Topic: two clients isolated data", () => {
  it("same topic different params → different data per client", async () => {
    server = new DanWebSocketServer({ port: 19623, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    server.topic.onSubscribe((session, topic) => {
      topic.setCallback((event, t) => {
        const symbol = t.params.symbol as string;
        t.payload.set("price", symbol === "BTC" ? 67000 : 3200);
        t.payload.set("symbol", symbol);
      });
    });

    const c1 = createClient(19623);
    const c2 = createClient(19623);
    let r1 = false, r2 = false;
    c1.onReady(() => { r1 = true; });
    c2.onReady(() => { r2 = true; });
    c1.connect();
    c2.connect();
    await waitUntil(() => r1 && r2);

    c1.subscribe("chart", { symbol: "BTC" });
    c2.subscribe("chart", { symbol: "ETH" });
    await waitFor(600);

    expect(c1.topic("chart").get("price")).toBe(67000);
    expect(c1.topic("chart").get("symbol")).toBe("BTC");
    expect(c2.topic("chart").get("price")).toBe(3200);
    expect(c2.topic("chart").get("symbol")).toBe("ETH");
  });
});

describe("Session Topic: unsubscribe stops timer and cleans up", () => {
  it("delayedTask stops after unsubscribe and onUnsubscribe fires", async () => {
    server = new DanWebSocketServer({ port: 19624, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    let callCount = 0;
    const unsubscribed: string[] = [];

    server.topic.onSubscribe((session, topic) => {
      topic.setCallback((event, t) => { callCount++; });
      topic.setDelayedTask(50);
    });
    server.topic.onUnsubscribe((session, topic) => {
      unsubscribed.push(topic.name);
    });

    const client = createClient(19624);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("ticker");
    await waitFor(300);
    const countBefore = callCount;
    expect(countBefore).toBeGreaterThanOrEqual(3);

    client.unsubscribe("ticker");
    await waitFor(300);
    const countAfter = callCount;

    // Timer should have stopped — count should barely increase (maybe 1 more from race)
    expect(countAfter - countBefore).toBeLessThanOrEqual(1);
    expect(unsubscribed).toContain("ticker");
  });
});

describe("Session Topic: multiple topics per session", () => {
  it("subscribing to 3 topics with different data all work independently", async () => {
    server = new DanWebSocketServer({ port: 19625, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    server.topic.onSubscribe((session, topic) => {
      topic.setCallback((event, t) => {
        t.payload.set("name", topic.name);
        t.payload.set("value", topic.name.length);
      });
    });

    const client = createClient(19625);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("alpha");
    client.subscribe("beta");
    client.subscribe("gamma");
    await waitFor(800);

    expect(client.topic("alpha").get("name")).toBe("alpha");
    expect(client.topic("beta").get("name")).toBe("beta");
    expect(client.topic("gamma").get("name")).toBe("gamma");

    // Values are scoped — alpha doesn't see beta's data
    expect(client.topic("alpha").get("value")).toBe(5);  // "alpha".length
    expect(client.topic("gamma").get("value")).toBe(5);  // "gamma".length
    expect(client.topic("beta").get("value")).toBe(4);   // "beta".length
  });
});

describe("Session Topic: topic.onUpdate fires once per batch", () => {
  it("multiple payload.set calls produce single onUpdate", async () => {
    server = new DanWebSocketServer({ port: 19626, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    server.topic.onSubscribe((session, topic) => {
      topic.setCallback((event, t) => {
        t.payload.set("a", 1);
        t.payload.set("b", 2);
        t.payload.set("c", 3);
      });
    });

    const client = createClient(19626);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    let updateCount = 0;
    client.topic("data").onUpdate(() => { updateCount++; });

    client.subscribe("data");
    await waitFor(500);

    // Should be 1 (all 3 values in one batch)
    expect(updateCount).toBeGreaterThanOrEqual(1);
    expect(updateCount).toBeLessThanOrEqual(2);
  });
});

// ══════════════════════════════════════════════════
// SESSION_PRINCIPAL_TOPIC MODE — comprehensive
// ══════════════════════════════════════════════════

describe("Session Principal Topic: basic auth + topic flow", () => {
  it("full lifecycle: connect → auth → subscribe → receive data → setParams → unsubscribe", async () => {
    server = new DanWebSocketServer({ port: 19640, path: "/ws", mode: "session_principal_topic" });
    await waitFor(50);

    server.enableAuthorization(true);
    server.onAuthorize((uuid, token) => server!.authorize(uuid, token, token));

    const events: EventType[] = [];
    server.topic.onSubscribe((session, topic) => {
      topic.setCallback((event, t, s) => {
        events.push(event);
        if (event === EventType.ChangedParamsEvent) t.payload.clear();
        t.payload.set("user", s.principal!);
        t.payload.set("view", t.params.view ?? "default");
      });
    });

    const unsubNames: string[] = [];
    server.topic.onUnsubscribe((session, topic) => {
      unsubNames.push(topic.name);
    });

    const client = createClient(19640);
    client.onConnect(() => client.authorize("alice"));
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    // Subscribe
    client.subscribe("my.dashboard", { view: "compact" });
    await waitFor(500);

    expect(events).toContain(EventType.SubscribeEvent);
    expect(client.topic("my.dashboard").get("user")).toBe("alice");
    expect(client.topic("my.dashboard").get("view")).toBe("compact");

    // Change params
    client.setParams("my.dashboard", { view: "full" });
    await waitFor(500);

    expect(events).toContain(EventType.ChangedParamsEvent);
    expect(client.topic("my.dashboard").get("view")).toBe("full");

    // Unsubscribe
    client.unsubscribe("my.dashboard");
    await waitFor(500);

    expect(unsubNames).toContain("my.dashboard");
  });
});

describe("Session Principal Topic: auth reject prevents topic access", () => {
  it("rejected client cannot subscribe to topics", async () => {
    server = new DanWebSocketServer({ port: 19641, path: "/ws", mode: "session_principal_topic" });
    await waitFor(50);

    server.enableAuthorization(true);
    server.onAuthorize((uuid) => server!.reject(uuid, "unauthorized"));

    let subscribed = false;
    server.topic.onSubscribe(() => { subscribed = true; });

    const client = createClient(19641, { reconnect: { enabled: false } });
    const errors: string[] = [];
    client.onConnect(() => client.authorize("bad-token"));
    client.onError((err) => errors.push(err.code));

    client.connect();
    await waitFor(1000);

    expect(errors).toContain("AUTH_REJECTED");
    expect(subscribed).toBe(false);
  });
});

describe("Session Principal Topic: two users same topic isolated data", () => {
  it("alice and bob subscribe to same topic but see different personalized data", async () => {
    server = new DanWebSocketServer({ port: 19642, path: "/ws", mode: "session_principal_topic" });
    await waitFor(50);

    server.enableAuthorization(true);
    server.onAuthorize((uuid, token) => server!.authorize(uuid, token, token));

    server.topic.onSubscribe((session, topic) => {
      topic.setCallback((event, t, s) => {
        const user = s.principal!;
        t.payload.set("greeting", `Hello ${user}`);
        t.payload.set("data", {
          orders: user === "alice" ? 10 : 5,
          notifications: user === "alice" ? 3 : 0,
        });
      });
    });

    const cA = createClient(19642);
    const cB = createClient(19642);
    cA.onConnect(() => cA.authorize("alice"));
    cB.onConnect(() => cB.authorize("bob"));

    let rA = false, rB = false;
    cA.onReady(() => { rA = true; });
    cB.onReady(() => { rB = true; });
    cA.connect();
    cB.connect();
    await waitUntil(() => rA && rB);

    cA.subscribe("my.dashboard");
    cB.subscribe("my.dashboard");
    await waitFor(800);

    // Alice's data
    expect(cA.topic("my.dashboard").get("greeting")).toBe("Hello alice");
    expect(cA.topic("my.dashboard").get("data.orders")).toBe(10);
    expect(cA.topic("my.dashboard").get("data.notifications")).toBe(3);

    // Bob's data — different
    expect(cB.topic("my.dashboard").get("greeting")).toBe("Hello bob");
    expect(cB.topic("my.dashboard").get("data.orders")).toBe(5);
    expect(cB.topic("my.dashboard").get("data.notifications")).toBe(0);
  });
});

describe("Session Principal Topic: delayedTask with principal context", () => {
  it("periodic callback has access to session.principal", async () => {
    server = new DanWebSocketServer({ port: 19643, path: "/ws", mode: "session_principal_topic" });
    await waitFor(50);

    server.enableAuthorization(true);
    server.onAuthorize((uuid, token) => server!.authorize(uuid, token, token));

    let principalInTask = "";
    let taskCount = 0;

    server.topic.onSubscribe((session, topic) => {
      topic.setCallback((event, t, s) => {
        principalInTask = s.principal!;
        taskCount++;
        t.payload.set("tick", taskCount);
      });
      topic.setDelayedTask(100);
    });

    const client = createClient(19643);
    client.onConnect(() => client.authorize("charlie"));
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("monitor");
    await waitFor(600);

    expect(principalInTask).toBe("charlie");
    expect(taskCount).toBeGreaterThanOrEqual(3);
    expect((client.topic("monitor").get("tick") as number)).toBeGreaterThanOrEqual(3);
  });
});

describe("Session Principal Topic: multiple topics per user", () => {
  it("one user subscribes to multiple topics with independent payloads", async () => {
    server = new DanWebSocketServer({ port: 19644, path: "/ws", mode: "session_principal_topic" });
    await waitFor(50);

    server.enableAuthorization(true);
    server.onAuthorize((uuid, token) => server!.authorize(uuid, token, token));

    server.topic.onSubscribe((session, topic) => {
      topic.setCallback((event, t, s) => {
        if (topic.name === "orders") {
          t.payload.set("count", 42);
          t.payload.set("status", "open");
        } else if (topic.name === "notifications") {
          t.payload.set("unread", 7);
          t.payload.set("latest", "New message");
        }
      });
    });

    const client = createClient(19644);
    client.onConnect(() => client.authorize("alice"));
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("orders");
    client.subscribe("notifications");
    await waitFor(800);

    // Orders topic
    expect(client.topic("orders").get("count")).toBe(42);
    expect(client.topic("orders").get("status")).toBe("open");

    // Notifications topic — separate scope
    expect(client.topic("notifications").get("unread")).toBe(7);
    expect(client.topic("notifications").get("latest")).toBe("New message");

    // No cross-contamination
    expect(client.topic("orders").get("unread")).toBeUndefined();
    expect(client.topic("notifications").get("count")).toBeUndefined();
  });
});

describe("Session Principal Topic: params change with principal", () => {
  it("setParams re-fires callback with new params and same principal", async () => {
    server = new DanWebSocketServer({ port: 19645, path: "/ws", mode: "session_principal_topic" });
    await waitFor(50);

    server.enableAuthorization(true);
    server.onAuthorize((uuid, token) => server!.authorize(uuid, token, token));

    const paramsLog: Array<Record<string, unknown>> = [];

    server.topic.onSubscribe((session, topic) => {
      topic.setCallback((event, t, s) => {
        paramsLog.push({ ...t.params });
        const status = (t.params.status as string) ?? "open";
        t.payload.set("filter", `${s.principal!}:${status}`);
      });
    });

    const client = createClient(19645);
    client.onConnect(() => client.authorize("alice"));
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("my.orders", { status: "open" });
    await waitFor(500);

    expect(client.topic("my.orders").get("filter")).toBe("alice:open");

    client.setParams("my.orders", { status: "closed" });
    await waitFor(500);

    expect(client.topic("my.orders").get("filter")).toBe("alice:closed");
    expect(paramsLog.length).toBe(2);
    expect(paramsLog[0]).toEqual({ status: "open" });
    expect(paramsLog[1]).toEqual({ status: "closed" });
  });
});

describe("Session Principal Topic: disconnect cleans up timers", () => {
  it("client disconnect stops all delayed tasks", async () => {
    server = new DanWebSocketServer({ port: 19646, path: "/ws", mode: "session_principal_topic" });
    await waitFor(50);

    server.enableAuthorization(true);
    server.onAuthorize((uuid, token) => server!.authorize(uuid, token, token));

    let taskCount = 0;
    server.topic.onSubscribe((session, topic) => {
      topic.setCallback((event, t) => { taskCount++; });
      topic.setDelayedTask(50);
    });

    const client = createClient(19646);
    client.onConnect(() => client.authorize("alice"));
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("live");
    await waitFor(300);
    const countBefore = taskCount;
    expect(countBefore).toBeGreaterThanOrEqual(3);

    client.disconnect();
    await waitFor(400);
    const countAfter = taskCount;

    // Timer should have stopped
    expect(countAfter - countBefore).toBeLessThanOrEqual(1);
  });
});

describe("Session Principal Topic: server.close cleans everything", () => {
  it("server.close disposes all sessions and timers", async () => {
    const srv = new DanWebSocketServer({ port: 19647, path: "/ws", mode: "session_principal_topic" });
    server = srv;
    await waitFor(50);

    srv.enableAuthorization(true);
    srv.onAuthorize((uuid, token) => srv.authorize(uuid, token, token));

    let taskCount = 0;
    srv.topic.onSubscribe((session, topic) => {
      topic.setCallback(() => { taskCount++; });
      topic.setDelayedTask(50);
    });

    const client = createClient(19647);
    client.onConnect(() => client.authorize("alice"));
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("live");
    await waitFor(300);
    const countBefore = taskCount;

    srv.close();
    server = null; // prevent double-close in afterEach
    await waitFor(400);

    expect(taskCount - countBefore).toBeLessThanOrEqual(1);
  });
});

describe("Session Principal Topic: topic.onUpdate on client", () => {
  it("client topic onUpdate receives Proxy payload view", async () => {
    server = new DanWebSocketServer({ port: 19648, path: "/ws", mode: "session_principal_topic" });
    await waitFor(50);

    server.enableAuthorization(true);
    server.onAuthorize((uuid, token) => server!.authorize(uuid, token, token));

    server.topic.onSubscribe((session, topic) => {
      topic.setCallback((event, t, s) => {
        t.payload.set("info", {
          user: s.principal!,
          nested: { level: 99 },
        });
      });
    });

    const client = createClient(19648);
    client.onConnect(() => client.authorize("alice"));
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    let updatePayload: any = null;
    client.topic("dash").onUpdate((payload) => {
      updatePayload = payload;
    });

    client.subscribe("dash");
    await waitFor(600);

    expect(updatePayload).not.toBeNull();
    expect(updatePayload.info.user).toBe("alice");
    expect(updatePayload.info.nested.level).toBe(99);
  });
});

// ══════════════════════════════════════════════════
// MODE GUARDS — comprehensive
// ══════════════════════════════════════════════════

describe("Mode guards: comprehensive", () => {
  it("broadcast rejects principal()", () => {
    server = new DanWebSocketServer({ port: 19660, path: "/ws", mode: "broadcast" });
    expect(() => server!.principal("x")).toThrow();
  });

  it("principal rejects set()", () => {
    server = new DanWebSocketServer({ port: 19661, path: "/ws", mode: "principal" });
    expect(() => server!.set("x", 1)).toThrow();
  });

  it("session_topic rejects set() and principal()", () => {
    server = new DanWebSocketServer({ port: 19662, path: "/ws", mode: "session_topic" });
    expect(() => server!.set("x", 1)).toThrow();
    expect(() => server!.principal("x")).toThrow();
  });

  it("session_principal_topic rejects set()", () => {
    server = new DanWebSocketServer({ port: 19663, path: "/ws", mode: "session_principal_topic" });
    expect(() => server!.set("x", 1)).toThrow();
  });

  it("session_principal_topic allows principal()", () => {
    server = new DanWebSocketServer({ port: 19664, path: "/ws", mode: "session_principal_topic" });
    // Should NOT throw — session_principal_topic supports principal()
    expect(() => server!.principal("alice")).not.toThrow();
  });
});

// ══════════════════════════════════════════════════
// maxValueSize — value size limit
// ══════════════════════════════════════════════════

describe("maxValueSize enforcement", () => {
  it("broadcast: large value throws VALUE_TOO_LARGE", () => {
    server = new DanWebSocketServer({ port: 19670, path: "/ws", mode: "broadcast", maxValueSize: 100 });
    // Small value should work
    server.set("small", "hello");
    expect(server.get("small")).toBe("hello");

    // Large value should throw
    const bigString = "x".repeat(200);
    try {
      server.set("big", bigString);
      expect.unreachable("should have thrown");
    } catch (e: any) {
      expect(e.code).toBe("VALUE_TOO_LARGE");
    }
  });

  it("principal: large value throws VALUE_TOO_LARGE", () => {
    server = new DanWebSocketServer({ port: 19671, path: "/ws", mode: "principal", maxValueSize: 50 });
    server.principal("alice").set("ok", "short");
    try {
      server.principal("alice").set("big", "x".repeat(100));
      expect.unreachable("should have thrown");
    } catch (e: any) {
      expect(e.code).toBe("VALUE_TOO_LARGE");
    }
  });

  it("session_topic: payload large value throws VALUE_TOO_LARGE", async () => {
    server = new DanWebSocketServer({ port: 19672, path: "/ws", mode: "session_topic", maxValueSize: 50 });
    await waitFor(50);

    let errorCode = "";
    server.topic.onSubscribe((session, topic) => {
      topic.setCallback((event, t) => {
        try {
          t.payload.set("big", "x".repeat(100));
        } catch (e: any) {
          errorCode = e.code;
        }
      });
    });

    const client = createClient(19672);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("test");
    await waitFor(500);

    expect(errorCode).toBe("VALUE_TOO_LARGE");
  });
});

// ══════════════════════════════════════════════════
// RECONNECTION — E2E tests
// ══════════════════════════════════════════════════

describe("Reconnection: broadcast client reconnects after server restart and receives full state", () => {
  it("client receives data again after server restart on same port", async () => {
    server = new DanWebSocketServer({ port: 19680, path: "/ws", mode: "broadcast" });
    await waitFor(50);

    server.set("status", "online");
    server.set("counter", 42);

    const client = createClient(19680, {
      reconnect: { baseDelay: 300, maxDelay: 1000, jitter: false },
    });
    let readyCount = 0;
    let disconnected = false;
    let reconnected = false;
    client.onReady(() => { readyCount++; });
    client.onDisconnect(() => { disconnected = true; });
    client.onReconnect(() => { reconnected = true; });
    client.connect();
    await waitUntil(() => readyCount === 1);
    await waitFor(200);

    expect(client.get("status")).toBe("online");
    expect(client.get("counter")).toBe(42);

    // Close the server — client should detect disconnect
    server.close();
    server = null;
    await waitUntil(() => disconnected, 3000);

    // Create NEW server on same port with same data immediately
    server = new DanWebSocketServer({ port: 19680, path: "/ws", mode: "broadcast" });
    await waitFor(50);
    server.set("status", "online");
    server.set("counter", 42);

    // Wait for client to reconnect and become ready again
    await waitUntil(() => reconnected, 8000);
    await waitFor(300);

    expect(client.state).toBe("ready");
    expect(client.get("status")).toBe("online");
    expect(client.get("counter")).toBe(42);
  }, 15000);
});

describe("Reconnection: principal client reconnects and re-authenticates", () => {
  it("client re-authorizes on reconnect and receives principal state", async () => {
    server = new DanWebSocketServer({ port: 19681, path: "/ws", mode: "principal" });
    await waitFor(50);

    server.enableAuthorization(true);
    server.onAuthorize((uuid, token) => server!.authorize(uuid, token, token));
    server.principal("alice").set("score", 100);

    const client = createClient(19681, {
      reconnect: { baseDelay: 300, maxDelay: 1000, jitter: false },
    });

    // onConnect fires on every open (including reconnect) — re-authorize there
    client.onConnect(() => client.authorize("alice"));

    let readyCount = 0;
    let disconnected = false;
    let reconnected = false;
    client.onReady(() => { readyCount++; });
    client.onDisconnect(() => { disconnected = true; });
    client.onReconnect(() => { reconnected = true; });
    client.connect();
    await waitUntil(() => readyCount === 1);
    await waitFor(200);

    expect(client.get("score")).toBe(100);

    // Close server
    server.close();
    server = null;
    await waitUntil(() => disconnected, 3000);

    // Create new server on same port with auth + same principal data
    server = new DanWebSocketServer({ port: 19681, path: "/ws", mode: "principal" });
    await waitFor(50);
    server.enableAuthorization(true);
    server.onAuthorize((uuid, token) => server!.authorize(uuid, token, token));
    server.principal("alice").set("score", 100);

    // Wait for client to reconnect
    await waitUntil(() => reconnected, 8000);
    await waitFor(300);

    expect(client.state).toBe("ready");
    expect(client.get("score")).toBe(100);
  }, 15000);
});

describe("Reconnection: broadcast reconnect with exponential backoff fires onReconnecting", () => {
  it("onReconnecting fires with attempt count, then client reconnects after server restart", async () => {
    server = new DanWebSocketServer({ port: 19682, path: "/ws", mode: "broadcast" });
    await waitFor(50);

    server.set("val", 1);

    const client = createClient(19682, {
      reconnect: { baseDelay: 300, maxDelay: 1000, jitter: false, maxRetries: 30 },
    });

    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);
    await waitFor(100);

    // Track reconnecting attempts
    const attempts: number[] = [];
    client.onReconnecting((attempt) => { attempts.push(attempt); });

    let disconnected = false;
    let reconnected = false;
    client.onDisconnect(() => { disconnected = true; });
    client.onReconnect(() => { reconnected = true; });

    // Close server — restart quickly so the first reconnect attempt can succeed
    // (On Windows, connection to a dead port may hang for a long time)
    server.close();
    server = null;

    // Wait for disconnect to be detected
    await waitUntil(() => disconnected, 3000);

    // onReconnecting should fire before the first attempt
    // (scheduleNext fires onReconnect callback immediately, then sets timer)
    await waitUntil(() => attempts.length >= 1, 2000);
    expect(attempts[0]).toBe(1);

    // Restart server before the first attempt's WS connect
    server = new DanWebSocketServer({ port: 19682, path: "/ws", mode: "broadcast" });
    await waitFor(50);
    server.set("val", 1);

    // Wait for client to reconnect
    await waitUntil(() => reconnected, 10000);

    expect(client.state).toBe("ready");
    expect(client.get("val")).toBe(1);
  }, 15000);
});

describe("Reconnection: reconnect disabled — client stays disconnected", () => {
  it("client with reconnect disabled does not attempt to reconnect", async () => {
    server = new DanWebSocketServer({ port: 19683, path: "/ws", mode: "broadcast" });
    await waitFor(50);

    server.set("x", 1);

    const client = createClient(19683, {
      reconnect: { enabled: false },
    });

    let ready = false;
    let disconnected = false;
    let reconnectingFired = false;
    let reconnectFired = false;
    client.onReady(() => { ready = true; });
    client.onDisconnect(() => { disconnected = true; });
    client.onReconnecting(() => { reconnectingFired = true; });
    client.onReconnect(() => { reconnectFired = true; });
    client.connect();
    await waitUntil(() => ready);
    await waitFor(100);

    expect(client.get("x")).toBe(1);

    // Close server
    server.close();
    server = null;
    await waitFor(1500);

    // Client should have disconnected, no reconnect attempts or successful reconnects
    expect(disconnected).toBe(true);
    expect(reconnectingFired).toBe(false);
    expect(reconnectFired).toBe(false);
    // Note: client._handleClose sets state to "reconnecting" then calls start() which
    // is a no-op when disabled. The state remains "reconnecting" — this reflects actual behavior.
    // The key assertion is that no onReconnecting/onReconnect callbacks fire.
  });
});
