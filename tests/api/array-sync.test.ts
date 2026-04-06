import { describe, it, expect, afterEach } from "vitest";
import { DanWebSocketServer } from "../../src/api/server.js";
import { DanWebSocketClient } from "../../src/api/client.js";

const BASE_PORT = 19900;
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

// ═══════════════════════════════════════════════════
// 1. Basic Array Operations
// ═══════════════════════════════════════════════════

describe("Array Sync: Basic Operations", () => {
  it("append (push) — [1,2,3] to [1,2,3,4]", async () => {
    const port = nextPort();
    const s = createServer(port);
    s.set("data", [1, 2, 3]);

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(300);

    expect(c.get("data.length")).toBe(3);
    expect(c.get("data.0")).toBe(1);
    expect(c.get("data.1")).toBe(2);
    expect(c.get("data.2")).toBe(3);

    s.set("data", [1, 2, 3, 4]);
    await waitFor(300);

    expect(c.get("data.length")).toBe(4);
    expect(c.get("data.3")).toBe(4);
    // existing elements unchanged
    expect(c.get("data.0")).toBe(1);
    expect(c.get("data.1")).toBe(2);
    expect(c.get("data.2")).toBe(3);
  });

  it("pop (shrink from end) — [1,2,3,4] to [1,2]", async () => {
    const port = nextPort();
    const s = createServer(port);
    s.set("data", [1, 2, 3, 4]);

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(300);

    expect(c.get("data.length")).toBe(4);

    s.set("data", [1, 2]);
    await waitFor(300);

    expect(c.get("data.length")).toBe(2);
    expect(c.get("data.0")).toBe(1);
    expect(c.get("data.1")).toBe(2);
  });

  it("full replace — [1,2,3] to [10,20,30]", async () => {
    const port = nextPort();
    const s = createServer(port);
    s.set("data", [1, 2, 3]);

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(300);

    expect(c.get("data.0")).toBe(1);

    s.set("data", [10, 20, 30]);
    await waitFor(300);

    expect(c.get("data.length")).toBe(3);
    expect(c.get("data.0")).toBe(10);
    expect(c.get("data.1")).toBe(20);
    expect(c.get("data.2")).toBe(30);
  });
});

// ═══════════════════════════════════════════════════
// 2. Left Shift (ARRAY_SHIFT_LEFT)
// ═══════════════════════════════════════════════════

describe("Array Sync: Left Shift", () => {
  it("shift+push sliding window — [1,2,3,4,5] to [2,3,4,5,6]", async () => {
    const port = nextPort();
    const s = createServer(port);
    s.set("data", [1, 2, 3, 4, 5]);

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(300);

    expect(c.get("data.length")).toBe(5);
    expect(c.get("data.0")).toBe(1);
    expect(c.get("data.4")).toBe(5);

    s.set("data", [2, 3, 4, 5, 6]);
    await waitFor(300);

    expect(c.get("data.length")).toBe(5);
    expect(c.get("data.0")).toBe(2);
    expect(c.get("data.1")).toBe(3);
    expect(c.get("data.2")).toBe(4);
    expect(c.get("data.3")).toBe(5);
    expect(c.get("data.4")).toBe(6);
  });

  it("pure shift (shrink from front) — [1,2,3,4,5] to [3,4,5]", async () => {
    const port = nextPort();
    const s = createServer(port);
    s.set("data", [1, 2, 3, 4, 5]);

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(300);

    expect(c.get("data.length")).toBe(5);

    s.set("data", [3, 4, 5]);
    await waitFor(300);

    expect(c.get("data.length")).toBe(3);
    expect(c.get("data.0")).toBe(3);
    expect(c.get("data.1")).toBe(4);
    expect(c.get("data.2")).toBe(5);
  });

  it("shift by 1 repeatedly — 10 iterations of shift+push", async () => {
    const port = nextPort();
    const s = createServer(port);
    let arr = [1, 2, 3, 4, 5];
    s.set("data", arr);

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(300);

    expect(c.get("data.length")).toBe(5);

    for (let i = 0; i < 10; i++) {
      arr = [...arr.slice(1), arr[arr.length - 1] + 1];
      s.set("data", arr);
      await waitFor(300);
    }

    // After 10 shifts: started [1,2,3,4,5], each iteration removes first and appends next
    // Final should be [11,12,13,14,15]
    expect(c.get("data.length")).toBe(5);
    expect(c.get("data.0")).toBe(11);
    expect(c.get("data.1")).toBe(12);
    expect(c.get("data.2")).toBe(13);
    expect(c.get("data.3")).toBe(14);
    expect(c.get("data.4")).toBe(15);
  });
});

// ═══════════════════════════════════════════════════
// 3. Right Shift (ARRAY_SHIFT_RIGHT)
// ═══════════════════════════════════════════════════

describe("Array Sync: Right Shift", () => {
  it("unshift (prepend) — [1,2,3,4,5] to [0,1,2,3,4]", async () => {
    const port = nextPort();
    const s = createServer(port);
    s.set("data", [1, 2, 3, 4, 5]);

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(300);

    expect(c.get("data.length")).toBe(5);
    expect(c.get("data.0")).toBe(1);

    s.set("data", [0, 1, 2, 3, 4]);
    await waitFor(300);

    expect(c.get("data.length")).toBe(5);
    expect(c.get("data.0")).toBe(0);
    expect(c.get("data.1")).toBe(1);
    expect(c.get("data.2")).toBe(2);
    expect(c.get("data.3")).toBe(3);
    expect(c.get("data.4")).toBe(4);
  });

  it("prepend+grow — [1,2,3] to [0,1,2,3]", async () => {
    const port = nextPort();
    const s = createServer(port);
    s.set("data", [1, 2, 3]);

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(300);

    expect(c.get("data.length")).toBe(3);

    s.set("data", [0, 1, 2, 3]);
    await waitFor(300);

    expect(c.get("data.length")).toBe(4);
    expect(c.get("data.0")).toBe(0);
    expect(c.get("data.1")).toBe(1);
    expect(c.get("data.2")).toBe(2);
    expect(c.get("data.3")).toBe(3);
  });

  it("right shift by 2 — [1,2,3] to [8,9,1,2,3]", async () => {
    const port = nextPort();
    const s = createServer(port);
    s.set("data", [1, 2, 3]);

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(300);

    expect(c.get("data.length")).toBe(3);

    s.set("data", [8, 9, 1, 2, 3]);
    await waitFor(300);

    expect(c.get("data.length")).toBe(5);
    expect(c.get("data.0")).toBe(8);
    expect(c.get("data.1")).toBe(9);
    expect(c.get("data.2")).toBe(1);
    expect(c.get("data.3")).toBe(2);
    expect(c.get("data.4")).toBe(3);
  });
});

// ═══════════════════════════════════════════════════
// 4. Object Elements in Arrays
// ═══════════════════════════════════════════════════

describe("Array Sync: Object Elements", () => {
  it("array of objects — shift+push with new object", async () => {
    const port = nextPort();
    const s = createServer(port);
    s.set("data", [
      { name: "A", val: 1 },
      { name: "B", val: 2 },
    ]);

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(300);

    expect(c.get("data.length")).toBe(2);
    expect(c.get("data.0.name")).toBe("A");
    expect(c.get("data.0.val")).toBe(1);
    expect(c.get("data.1.name")).toBe("B");
    expect(c.get("data.1.val")).toBe(2);

    // shift+push: remove first, add new at end
    s.set("data", [
      { name: "B", val: 2 },
      { name: "C", val: 3 },
    ]);
    await waitFor(300);

    expect(c.get("data.length")).toBe(2);
    expect(c.get("data.0.name")).toBe("B");
    expect(c.get("data.0.val")).toBe(2);
    expect(c.get("data.1.name")).toBe("C");
    expect(c.get("data.1.val")).toBe(3);
  });

  it("nested object keys work after shift", async () => {
    const port = nextPort();
    const s = createServer(port);
    s.set("items", [
      { id: 1, meta: { color: "red", size: 10 } },
      { id: 2, meta: { color: "blue", size: 20 } },
      { id: 3, meta: { color: "green", size: 30 } },
    ]);

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(300);

    expect(c.get("items.0.meta.color")).toBe("red");
    expect(c.get("items.2.meta.size")).toBe(30);

    // shift left by 1 + push
    s.set("items", [
      { id: 2, meta: { color: "blue", size: 20 } },
      { id: 3, meta: { color: "green", size: 30 } },
      { id: 4, meta: { color: "yellow", size: 40 } },
    ]);
    await waitFor(300);

    expect(c.get("items.length")).toBe(3);
    expect(c.get("items.0.id")).toBe(2);
    expect(c.get("items.0.meta.color")).toBe("blue");
    expect(c.get("items.1.meta.color")).toBe("green");
    expect(c.get("items.2.id")).toBe(4);
    expect(c.get("items.2.meta.color")).toBe("yellow");
    expect(c.get("items.2.meta.size")).toBe(40);
  });
});

// ═══════════════════════════════════════════════════
// 5. Edge Cases
// ═══════════════════════════════════════════════════

describe("Array Sync: Edge Cases", () => {
  it("empty array then add elements", async () => {
    const port = nextPort();
    const s = createServer(port);
    s.set("data", [] as number[]);

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(300);

    expect(c.get("data.length")).toBe(0);

    s.set("data", [42, 99]);
    await waitFor(300);

    expect(c.get("data.length")).toBe(2);
    expect(c.get("data.0")).toBe(42);
    expect(c.get("data.1")).toBe(99);
  });

  it("array with 1 element — shift+push", async () => {
    const port = nextPort();
    const s = createServer(port);
    s.set("data", [100]);

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(300);

    expect(c.get("data.length")).toBe(1);
    expect(c.get("data.0")).toBe(100);

    s.set("data", [200]);
    await waitFor(300);

    expect(c.get("data.length")).toBe(1);
    expect(c.get("data.0")).toBe(200);
  });

  it("large array (50 elements) shift+push", async () => {
    const port = nextPort();
    const s = createServer(port);
    const arr = Array.from({ length: 50 }, (_, i) => i);
    s.set("data", arr);

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(500);

    expect(c.get("data.length")).toBe(50);
    expect(c.get("data.0")).toBe(0);
    expect(c.get("data.49")).toBe(49);

    // shift left by 1, push 50
    const shifted = [...arr.slice(1), 50];
    s.set("data", shifted);
    await waitFor(500);

    expect(c.get("data.length")).toBe(50);
    expect(c.get("data.0")).toBe(1);
    expect(c.get("data.49")).toBe(50);
  });

  it("alternating left and right shifts", async () => {
    const port = nextPort();
    const s = createServer(port);
    s.set("data", [1, 2, 3, 4, 5]);

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(300);

    // Left shift: [2,3,4,5,6]
    s.set("data", [2, 3, 4, 5, 6]);
    await waitFor(300);
    expect(c.get("data.0")).toBe(2);
    expect(c.get("data.4")).toBe(6);

    // Right shift: [0,2,3,4,5,6] — grows array, triggers incremental key registration
    s.set("data", [0, 2, 3, 4, 5, 6]);
    await waitFor(500);
    expect(c.get("data.length")).toBe(6);
    expect(c.get("data.0")).toBe(0);
    expect(c.get("data.5")).toBe(6);

    // Left shift again: [3,4,5,6]
    s.set("data", [3, 4, 5, 6]);
    await waitFor(500);
    expect(c.get("data.length")).toBe(4);
    expect(c.get("data.0")).toBe(3);
    expect(c.get("data.3")).toBe(6);
  });

  it("array of strings", async () => {
    const port = nextPort();
    const s = createServer(port);
    s.set("tags", ["alpha", "beta", "gamma"]);

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(300);

    expect(c.get("tags.length")).toBe(3);
    expect(c.get("tags.0")).toBe("alpha");
    expect(c.get("tags.2")).toBe("gamma");

    // shift+push
    s.set("tags", ["beta", "gamma", "delta"]);
    await waitFor(300);

    expect(c.get("tags.length")).toBe(3);
    expect(c.get("tags.0")).toBe("beta");
    expect(c.get("tags.1")).toBe("gamma");
    expect(c.get("tags.2")).toBe("delta");
  });

  it("array of booleans", async () => {
    const port = nextPort();
    const s = createServer(port);
    s.set("flags", [true, false, true, false]);

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(300);

    expect(c.get("flags.length")).toBe(4);
    expect(c.get("flags.0")).toBe(true);
    expect(c.get("flags.1")).toBe(false);
    expect(c.get("flags.2")).toBe(true);
    expect(c.get("flags.3")).toBe(false);

    // shift+push
    s.set("flags", [false, true, false, true]);
    await waitFor(300);

    expect(c.get("flags.0")).toBe(false);
    expect(c.get("flags.1")).toBe(true);
    expect(c.get("flags.2")).toBe(false);
    expect(c.get("flags.3")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════
// 6. Practical Use Cases — Stock/Crypto Chart
// ═══════════════════════════════════════════════════

describe("Array Sync: Stock/Crypto Chart Use Cases", () => {
  it("candlestick chart — 20 candles, shift+push new candle", async () => {
    const port = nextPort();
    const s = createServer(port);

    const makeCandle = (i: number) => ({
      open: 100 + i,
      high: 105 + i,
      low: 95 + i,
      close: 102 + i,
      volume: 1000 * (i + 1),
      timestamp: 1700000000 + i * 60,
    });

    const candles = Array.from({ length: 20 }, (_, i) => makeCandle(i));
    s.set("chart", candles);

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(500);

    expect(c.get("chart.length")).toBe(20);
    expect(c.get("chart.0.open")).toBe(100);
    expect(c.get("chart.0.timestamp")).toBe(1700000000);
    expect(c.get("chart.19.open")).toBe(119);
    expect(c.get("chart.19.volume")).toBe(20000);

    // New candle arrives: shift left, push new candle
    const newCandles = [...candles.slice(1), makeCandle(20)];
    s.set("chart", newCandles);
    await waitFor(500);

    expect(c.get("chart.length")).toBe(20);
    // First candle is now index 1 from original
    expect(c.get("chart.0.open")).toBe(101);
    expect(c.get("chart.0.timestamp")).toBe(1700000060);
    // Last candle is the new one
    expect(c.get("chart.19.open")).toBe(120);
    expect(c.get("chart.19.high")).toBe(125);
    expect(c.get("chart.19.low")).toBe(115);
    expect(c.get("chart.19.close")).toBe(122);
    expect(c.get("chart.19.volume")).toBe(21000);
    expect(c.get("chart.19.timestamp")).toBe(1700000000 + 20 * 60);
  });

  it("price ticker — 100 prices, shift+push 5 times", async () => {
    const port = nextPort();
    const s = createServer(port);

    const prices = Array.from({ length: 100 }, (_, i) => 50000 + i * 10);
    s.set("prices", prices);

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(500);

    expect(c.get("prices.length")).toBe(100);
    expect(c.get("prices.0")).toBe(50000);
    expect(c.get("prices.99")).toBe(50990);

    let current = [...prices];
    for (let i = 0; i < 5; i++) {
      current = [...current.slice(1), 51000 + i * 10];
      s.set("prices", current);
      await waitFor(300);
    }

    expect(c.get("prices.length")).toBe(100);
    // After 5 shifts, first element was originally at index 5
    expect(c.get("prices.0")).toBe(50050);
    // Last element is the most recent push
    expect(c.get("prices.99")).toBe(51040);
  });

  it("order book — array of {price, qty} objects, shift+push", async () => {
    const port = nextPort();
    const s = createServer(port);

    const orders = [
      { price: 100.5, qty: 10 },
      { price: 101.0, qty: 25 },
      { price: 101.5, qty: 15 },
      { price: 102.0, qty: 30 },
      { price: 102.5, qty: 5 },
    ];
    s.set("orderbook", orders);

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);
    await waitFor(300);

    expect(c.get("orderbook.length")).toBe(5);
    expect(c.get("orderbook.0.price")).toBe(100.5);
    expect(c.get("orderbook.0.qty")).toBe(10);
    expect(c.get("orderbook.4.price")).toBe(102.5);

    // Shift + push new order level
    const updated = [
      ...orders.slice(1),
      { price: 103.0, qty: 20 },
    ];
    s.set("orderbook", updated);
    await waitFor(300);

    expect(c.get("orderbook.length")).toBe(5);
    expect(c.get("orderbook.0.price")).toBe(101.0);
    expect(c.get("orderbook.0.qty")).toBe(25);
    expect(c.get("orderbook.4.price")).toBe(103.0);
    expect(c.get("orderbook.4.qty")).toBe(20);
  });
});

// ═══════════════════════════════════════════════════
// 7. Topic Mode Array Sync
// ═══════════════════════════════════════════════════

describe("Array Sync: Topic Mode", () => {
  it("topic payload array shift+push", async () => {
    const port = nextPort();
    const s = createServer(port, "session_topic");

    let pushCount = 0;
    const initialData = [10, 20, 30, 40, 50];

    s.topic.onSubscribe((session, topic) => {
      topic.setCallback((event, t) => {
        if (pushCount === 0) {
          t.payload.set("series", initialData);
        }
        pushCount++;
      });
    });

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);

    c.subscribe("chart-feed");
    await waitFor(500);

    const topic = c.topic("chart-feed");
    expect(topic.get("series.length")).toBe(5);
    expect(topic.get("series.0")).toBe(10);
    expect(topic.get("series.4")).toBe(50);
  });

  it("topic payload with object array", async () => {
    const port = nextPort();
    const s = createServer(port, "session_topic");

    s.topic.onSubscribe((session, topic) => {
      topic.setCallback((event, t) => {
        t.payload.set("items", [
          { symbol: "BTC", price: 65000 },
          { symbol: "ETH", price: 3200 },
        ]);
      });
    });

    const c = createClient(port);
    let ready = false;
    c.onReady(() => { ready = true; });
    c.connect();
    await waitUntil(() => ready);

    c.subscribe("tickers");
    await waitFor(500);

    const topic = c.topic("tickers");
    expect(topic.get("items.length")).toBe(2);
    expect(topic.get("items.0.symbol")).toBe("BTC");
    expect(topic.get("items.0.price")).toBe(65000);
    expect(topic.get("items.1.symbol")).toBe("ETH");
    expect(topic.get("items.1.price")).toBe(3200);
  });
});
