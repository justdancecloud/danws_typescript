/**
 * Extreme Traffic Stress Tests
 * 300 / 500 / 1000 / 10000 concurrent clients
 */
import { describe, it, expect, afterEach } from "vitest";
import { DanWebSocketServer, EventType } from "../../src/api/server.js";
import { DanWebSocketClient } from "../../src/api/client.js";

function waitFor(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

let server: DanWebSocketServer | null = null;
const clients: DanWebSocketClient[] = [];

function createClients(port: number, count: number): DanWebSocketClient[] {
  const arr: DanWebSocketClient[] = [];
  for (let i = 0; i < count; i++) {
    const c = new DanWebSocketClient(`ws://127.0.0.1:${port}`, { reconnect: { enabled: false } });
    arr.push(c);
    clients.push(c);
  }
  return arr;
}

async function connectAll(arr: DanWebSocketClient[]): Promise<number> {
  let readyCount = 0;
  const promises = arr.map(c => new Promise<void>((resolve) => {
    c.onReady(() => { readyCount++; resolve(); });
    const timeout = setTimeout(() => resolve(), 15000); // don't block forever
    c.onReady(() => clearTimeout(timeout));
    c.connect();
  }));
  await Promise.all(promises);
  return readyCount;
}

afterEach(async () => {
  // Batch disconnect to avoid overwhelming
  const batch = 200;
  for (let i = 0; i < clients.length; i += batch) {
    const slice = clients.slice(i, i + batch);
    slice.forEach(c => { try { c.disconnect(); } catch {} });
    if (i + batch < clients.length) await waitFor(50);
  }
  clients.length = 0;
  if (server) { server.close(); server = null; }
  await waitFor(200);
});

// ════════════════════════════════════════
// 300 Clients
// ════════════════════════════════════════

describe("Stress: 300 clients", () => {
  it("broadcast — all 300 receive flattened object", async () => {
    server = new DanWebSocketServer({ port: 19900, mode: "broadcast" });

    server.set("dashboard", {
      cpu: 72.5,
      memory: { used: 8.2, total: 16 },
      status: "online",
    });

    const arr = createClients(19900, 300);
    const start = Date.now();
    const readyCount = await connectAll(arr);
    const connectTime = Date.now() - start;

    console.log(`  300 clients connected in ${connectTime}ms (${readyCount} ready)`);
    expect(readyCount).toBeGreaterThanOrEqual(280); // allow 93%+ success

    await waitFor(500);

    // Sample check
    let successCount = 0;
    for (const c of arr) {
      if (c.get("dashboard.cpu") === 72.5 && c.get("dashboard.memory.used") === 8.2) {
        successCount++;
      }
    }
    console.log(`  300 clients: ${successCount} received correct data`);
    expect(successCount).toBeGreaterThanOrEqual(280);
  }, 30000);

  it("broadcast — live update reaches all 300", async () => {
    server = new DanWebSocketServer({ port: 19901, mode: "broadcast" });
    server.set("counter", 0);

    const arr = createClients(19901, 300);
    const readyCount = await connectAll(arr);
    expect(readyCount).toBeGreaterThanOrEqual(280);

    await waitFor(300);

    // Send update
    server.set("counter", 999);
    await waitFor(1000);

    let received = 0;
    for (const c of arr) {
      if (c.get("counter") === 999) received++;
    }
    console.log(`  300 clients: ${received} received update`);
    expect(received).toBeGreaterThanOrEqual(280);
  }, 30000);
});

// ════════════════════════════════════════
// 500 Clients
// ════════════════════════════════════════

describe("Stress: 500 clients", () => {
  it("broadcast — 500 clients receive auto-flattened data", async () => {
    server = new DanWebSocketServer({ port: 19902, mode: "broadcast" });

    server.set("state", {
      users: [
        { name: "Alice", score: 100 },
        { name: "Bob", score: 200 },
      ],
      meta: { total: 2, updated: new Date() },
    });

    const arr = createClients(19902, 500);
    const start = Date.now();
    const readyCount = await connectAll(arr);
    const connectTime = Date.now() - start;

    console.log(`  500 clients connected in ${connectTime}ms (${readyCount} ready)`);
    expect(readyCount).toBeGreaterThanOrEqual(450);

    await waitFor(1000);

    let successCount = 0;
    for (const c of arr) {
      if (c.get("state.users.0.name") === "Alice" && c.get("state.meta.total") === 2) {
        successCount++;
      }
    }
    console.log(`  500 clients: ${successCount} received correct data`);
    expect(successCount).toBeGreaterThanOrEqual(450);
  }, 30000);

  it("broadcast — rapid updates under 500 clients", async () => {
    server = new DanWebSocketServer({ port: 19903, mode: "broadcast" });
    server.set("tick", 0);

    const arr = createClients(19903, 500);
    const readyCount = await connectAll(arr);
    expect(readyCount).toBeGreaterThanOrEqual(450);
    await waitFor(500);

    // Rapid fire 50 updates
    for (let i = 1; i <= 50; i++) {
      server.set("tick", i);
    }
    await waitFor(2000);

    let gotFinal = 0;
    for (const c of arr) {
      if (c.get("tick") === 50) gotFinal++;
    }
    console.log(`  500 clients: ${gotFinal} got final tick=50`);
    expect(gotFinal).toBeGreaterThanOrEqual(450);
  }, 30000);
});

// ════════════════════════════════════════
// 1000 Clients
// ════════════════════════════════════════

describe("Stress: 1000 clients", () => {
  it("broadcast — 1000 clients connect and receive data", async () => {
    server = new DanWebSocketServer({ port: 19904, mode: "broadcast" });
    server.set("msg", "hello-1000");

    const arr = createClients(19904, 1000);
    const start = Date.now();
    const readyCount = await connectAll(arr);
    const connectTime = Date.now() - start;

    console.log(`  1000 clients connected in ${connectTime}ms (${readyCount} ready)`);
    expect(readyCount).toBeGreaterThanOrEqual(900);

    await waitFor(1500);

    let successCount = 0;
    for (const c of arr) {
      if (c.get("msg") === "hello-1000") successCount++;
    }
    console.log(`  1000 clients: ${successCount} received data`);
    expect(successCount).toBeGreaterThanOrEqual(900);
  }, 60000);

  it("broadcast — flattened object to 1000 clients", async () => {
    server = new DanWebSocketServer({ port: 19905, mode: "broadcast" });

    server.set("config", {
      db: { host: "localhost", port: 5432 },
      cache: { enabled: true, ttl: 300 },
      features: ["auth", "logging", "metrics"],
    });

    const arr = createClients(19905, 1000);
    const readyCount = await connectAll(arr);
    expect(readyCount).toBeGreaterThanOrEqual(900);
    await waitFor(2000);

    let successCount = 0;
    for (const c of arr) {
      if (c.get("config.db.host") === "localhost" &&
          c.get("config.features.length") === 3 &&
          c.get("config.features.1") === "logging") {
        successCount++;
      }
    }
    console.log(`  1000 clients: ${successCount} received flattened config`);
    expect(successCount).toBeGreaterThanOrEqual(900);
  }, 60000);
});

// ════════════════════════════════════════
// 10000 Clients (extreme)
// ════════════════════════════════════════

describe("Stress: 10000 clients", () => {
  it("broadcast — 10000 clients connect and receive", async () => {
    server = new DanWebSocketServer({ port: 19906, mode: "broadcast" });
    server.set("ping", "pong");

    // Connect in batches to avoid overwhelming OS
    const batchSize = 500;
    const totalClients = 10000;
    let totalReady = 0;

    const start = Date.now();

    for (let i = 0; i < totalClients; i += batchSize) {
      const count = Math.min(batchSize, totalClients - i);
      const batch = createClients(19906, count);
      const readyCount = await connectAll(batch);
      totalReady += readyCount;
      // Small pause between batches
      if (i + batchSize < totalClients) await waitFor(100);
    }

    const connectTime = Date.now() - start;
    console.log(`  10000 clients: ${totalReady} connected in ${connectTime}ms`);

    // Allow longer for all data to propagate
    await waitFor(5000);

    let successCount = 0;
    for (const c of clients) {
      if (c.get("ping") === "pong") successCount++;
    }
    const successRate = ((successCount / totalClients) * 100).toFixed(1);
    console.log(`  10000 clients: ${successCount} received data (${successRate}%)`);

    // At this scale, 80%+ is acceptable (OS/memory limits)
    expect(successCount).toBeGreaterThanOrEqual(totalClients * 0.8);
  }, 120000);

  it("broadcast — live update reaches 10000 clients", async () => {
    server = new DanWebSocketServer({ port: 19907, mode: "broadcast" });
    server.set("version", 0);

    const batchSize = 500;
    const totalClients = 10000;
    let totalReady = 0;

    for (let i = 0; i < totalClients; i += batchSize) {
      const count = Math.min(batchSize, totalClients - i);
      const batch = createClients(19907, count);
      const readyCount = await connectAll(batch);
      totalReady += readyCount;
      if (i + batchSize < totalClients) await waitFor(100);
    }
    console.log(`  10000 clients: ${totalReady} connected`);

    await waitFor(3000);

    // Send update
    const updateStart = Date.now();
    server.set("version", 42);
    await waitFor(5000);

    let received = 0;
    for (const c of clients) {
      if (c.get("version") === 42) received++;
    }
    const updateTime = Date.now() - updateStart;
    const rate = ((received / totalClients) * 100).toFixed(1);
    console.log(`  10000 clients: ${received} received update in ${updateTime}ms (${rate}%)`);

    expect(received).toBeGreaterThanOrEqual(totalClients * 0.8);
  }, 120000);
});

// ════════════════════════════════════════
// Topic mode stress
// ════════════════════════════════════════

describe("Stress: Topic mode", () => {
  it("300 clients subscribing to different topics", async () => {
    server = new DanWebSocketServer({ port: 19908, mode: "session_topic" });

    server.topic.onSubscribe((session, topic) => {
      topic.setCallback((event, t) => {
        t.payload.set("data", { topic: t.name, session: session.id.slice(0, 8) });
      });
    });

    const arr = createClients(19908, 300);
    const readyCount = await connectAll(arr);
    expect(readyCount).toBeGreaterThanOrEqual(270);

    // Each client subscribes to a unique topic
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].state === "ready") {
        arr[i].subscribe(`topic-${i}`);
      }
    }
    await waitFor(3000);

    // Sample check — first 10 clients
    let verified = 0;
    for (let i = 0; i < Math.min(10, arr.length); i++) {
      const topicData = arr[i].topic(`topic-${i}`).get("data.topic");
      if (topicData === `topic-${i}`) verified++;
    }
    console.log(`  300 topic clients: ${verified}/10 sampled correctly`);
    expect(verified).toBeGreaterThanOrEqual(8);
  }, 30000);
});
