import { describe, it, expect, afterEach } from "vitest";
import { DanWebSocketServer } from "../../src/api/server.js";
import { DanWebSocketClient } from "../../src/api/client.js";
import type { DanWebSocketSession } from "../../src/api/session.js";
import type { TopicInfo } from "../../src/api/session.js";

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
// session_topic mode
// ────────────────────────────────────────────────

describe("E2E: session_topic Mode", () => {
  it("client subscribes and server pushes data per-session", async () => {
    server = new DanWebSocketServer({ port: 19100, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    const subscribed: Array<{ topic: TopicInfo }> = [];
    server.onTopicSubscribe((session, topic) => {
      subscribed.push({ topic: { ...topic } });
      session.set("posts.count", 42);
    });

    const client = createClient(19100);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("board.posts", { page: 1, size: 20 });
    await waitFor(500);

    expect(subscribed.length).toBe(1);
    expect(subscribed[0].topic.name).toBe("board.posts");
    expect(subscribed[0].topic.params).toEqual({ page: 1, size: 20 });

    // Wait for server push
    await waitFor(300);
    expect(client.get("posts.count")).toBe(42);
  });

  it("multiple topic subscriptions", async () => {
    server = new DanWebSocketServer({ port: 19101, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    const topics: string[] = [];
    server.onTopicSubscribe((session, topic) => { topics.push(topic.name); });

    const client = createClient(19101);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("board.posts", { page: 1 });
    await waitFor(500);

    client.subscribe("chart.sales", { range: "7d" });
    await waitFor(500);

    expect(topics).toContain("board.posts");
    expect(topics).toContain("chart.sales");
    expect(client.topics.sort()).toEqual(["board.posts", "chart.sales"]);
  });

  it("unsubscribe triggers onTopicUnsubscribe", async () => {
    server = new DanWebSocketServer({ port: 19102, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    const unsubscribed: string[] = [];
    server.onTopicSubscribe(() => {});
    server.onTopicUnsubscribe((session, name) => { unsubscribed.push(name); });

    const client = createClient(19102);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("board.posts", { page: 1 });
    await waitFor(500);

    client.unsubscribe("board.posts");
    await waitFor(500);

    expect(unsubscribed).toContain("board.posts");
    expect(client.topics).toEqual([]);
  });

  it("setParams triggers onTopicParamsChange", async () => {
    server = new DanWebSocketServer({ port: 19103, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    const changes: Array<{ name: string; params: Record<string, unknown> }> = [];
    server.onTopicSubscribe(() => {});
    server.onTopicParamsChange((session, topic) => {
      changes.push({ name: topic.name, params: { ...topic.params } });
    });

    const client = createClient(19103);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("board.posts", { page: 1, size: 20 });
    await waitFor(500);

    client.setParams("board.posts", { page: 2, size: 20 });
    await waitFor(500);

    expect(changes.length).toBe(1);
    expect(changes[0].name).toBe("board.posts");
    expect(changes[0].params.page).toBe(2);
  });

  it("server can read session topics", async () => {
    server = new DanWebSocketServer({ port: 19104, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    let verified = false;
    server.onTopicSubscribe((session, topic) => {
      expect(session.topics).toContain("board.posts");
      expect(session.topic("board.posts")!.params).toEqual({ page: 1, size: 20 });
      verified = true;
    });

    const client = createClient(19104);
    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("board.posts", { page: 1, size: 20 });
    await waitUntil(() => verified);
  });

  it("two sessions get different data for same topic", async () => {
    server = new DanWebSocketServer({ port: 19105, path: "/ws", mode: "session_topic" });
    await waitFor(50);

    server.onTopicSubscribe((session, topic) => {
      const page = topic.params.page as number;
      session.set("data", `page-${page}`);
    });

    const c1 = createClient(19105);
    const c2 = createClient(19105);
    let r1 = false, r2 = false;
    c1.onReady(() => { r1 = true; });
    c2.onReady(() => { r2 = true; });
    c1.connect();
    c2.connect();
    await waitUntil(() => r1 && r2);

    c1.subscribe("posts", { page: 1 });
    c2.subscribe("posts", { page: 2 });
    await waitFor(800);

    expect(c1.get("data")).toBe("page-1");
    expect(c2.get("data")).toBe("page-2");
  });
});

// ────────────────────────────────────────────────
// session_principal_topic mode
// ────────────────────────────────────────────────

describe("E2E: session_principal_topic Mode", () => {
  it("auth + topic subscribe with principal", async () => {
    server = new DanWebSocketServer({ port: 19110, path: "/ws", mode: "session_principal_topic" });
    await waitFor(50);

    server.enableAuthorization(true);
    server.onAuthorize((uuid, token) => server!.authorize(uuid, token, token));

    let receivedPrincipal = "";
    server.onTopicSubscribe((session, topic) => {
      receivedPrincipal = session.principal!;
      session.set("greeting", `Hello ${session.principal}`);
    });

    const client = createClient(19110);
    client.onConnect(() => client.authorize("alice"));

    let ready = false;
    client.onReady(() => { ready = true; });
    client.connect();
    await waitUntil(() => ready);

    client.subscribe("dashboard", { view: "main" });
    await waitFor(500);

    expect(receivedPrincipal).toBe("alice");
    await waitFor(300);
    expect(client.get("greeting")).toBe("Hello alice");
  });

  it("different users get per-session data", async () => {
    server = new DanWebSocketServer({ port: 19111, path: "/ws", mode: "session_principal_topic" });
    await waitFor(50);

    server.enableAuthorization(true);
    server.onAuthorize((uuid, token) => server!.authorize(uuid, token, token));

    server.onTopicSubscribe((session, topic) => {
      session.set("user", session.principal!);
    });

    const c1 = createClient(19111);
    const c2 = createClient(19111);
    c1.onConnect(() => c1.authorize("alice"));
    c2.onConnect(() => c2.authorize("bob"));

    let r1 = false, r2 = false;
    c1.onReady(() => { r1 = true; });
    c2.onReady(() => { r2 = true; });
    c1.connect();
    c2.connect();
    await waitUntil(() => r1 && r2);

    c1.subscribe("profile", {});
    c2.subscribe("profile", {});
    await waitFor(800);

    expect(c1.get("user")).toBe("alice");
    expect(c2.get("user")).toBe("bob");
  });
});

// ────────────────────────────────────────────────
// Mode guard tests
// ────────────────────────────────────────────────

describe("Mode guards", () => {
  it("session_topic rejects server.set()", () => {
    server = new DanWebSocketServer({ port: 19120, path: "/ws", mode: "session_topic" });
    expect(() => server!.set("key", "val")).toThrow();
  });

  it("session_topic rejects server.principal()", () => {
    server = new DanWebSocketServer({ port: 19121, path: "/ws", mode: "session_topic" });
    expect(() => server!.principal("alice")).toThrow();
  });
});
