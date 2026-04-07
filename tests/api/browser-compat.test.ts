import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DanWebSocketClient, DanWSError } from "../../src/index.js";

describe("Browser Compatibility", () => {
  let savedWebSocket: any;

  beforeEach(() => {
    savedWebSocket = globalThis.WebSocket;
  });

  afterEach(() => {
    // Restore original WebSocket
    if (savedWebSocket !== undefined) {
      (globalThis as any).WebSocket = savedWebSocket;
    } else {
      delete (globalThis as any).WebSocket;
    }
  });

  // ── Test 1: Client entry point exports are clean ──

  it("DanWebSocketClient is exported as a constructor", () => {
    expect(typeof DanWebSocketClient).toBe("function");
    expect(DanWebSocketClient.prototype).toBeDefined();
    expect(DanWebSocketClient.prototype.constructor).toBe(DanWebSocketClient);
  });

  it("DanWSError is exported as a constructor", () => {
    expect(typeof DanWSError).toBe("function");
    const err = new DanWSError("NO_WEBSOCKET", "test");
    expect(err).toBeInstanceOf(DanWSError);
    expect(err.code).toBe("NO_WEBSOCKET");
  });

  // ── Test 2: Client uses globalThis.WebSocket when available ──

  it("uses globalThis.WebSocket mock instead of ws module", () => {
    const instances: any[] = [];

    class MockWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      url: string;
      binaryType = "blob";
      readyState = 0;
      onopen: ((ev: any) => void) | null = null;
      onclose: ((ev: any) => void) | null = null;
      onerror: ((ev: any) => void) | null = null;
      onmessage: ((ev: any) => void) | null = null;

      constructor(url: string) {
        this.url = url;
        instances.push(this);
      }

      send(_data: any) {}
      close() { this.readyState = 3; }
    }

    // Set mock as globalThis.WebSocket
    (globalThis as any).WebSocket = MockWebSocket;

    const client = new DanWebSocketClient("ws://127.0.0.1:19690/ws");
    client.connect();

    // Verify that our mock was used (an instance was created)
    expect(instances.length).toBe(1);
    expect(instances[0]).toBeInstanceOf(MockWebSocket);
    expect(instances[0].url).toBe("ws://127.0.0.1:19690/ws");
    expect(instances[0].binaryType).toBe("arraybuffer");

    client.disconnect();
  });

  // ── Test 3: Throws NO_WEBSOCKET when no WebSocket available ──

  it("throws NO_WEBSOCKET when no WebSocket implementation exists", () => {
    // Remove globalThis.WebSocket
    delete (globalThis as any).WebSocket;

    // Also need to prevent the fallback require("ws") from working.
    // The client uses globalThis.require as fallback. In Node/vitest,
    // globalThis.require may not exist (ESM), but the code checks
    // g["require"]. We temporarily shadow it.
    const origRequire = (globalThis as any).require;
    delete (globalThis as any).require;

    const client = new DanWebSocketClient("ws://127.0.0.1:19691/ws");

    const errors: DanWSError[] = [];
    client.onError((err) => errors.push(err));

    // connect() should catch the error internally and trigger handleClose
    // The _getWebSocketImpl throws, which is caught in connect()'s try/catch
    // We need to verify the error is a NO_WEBSOCKET
    // Since connect() catches the error, let's call _getWebSocketImpl indirectly
    // by checking that connect triggers reconnect (because it fails)

    // Actually, let's directly test by accessing the private method via prototype trick
    // Or we can just verify client goes to reconnecting state after failed connect
    client.connect();

    // The connect() catches the error and calls _handleClose which starts reconnect.
    // State should be "reconnecting" (not "ready" or "connecting")
    expect(client.state).toBe("reconnecting");

    // Clean up - disconnect to stop reconnect engine
    client.disconnect();

    // Restore require
    if (origRequire !== undefined) {
      (globalThis as any).require = origRequire;
    }
  });

  it("_getWebSocketImpl throws DanWSError with NO_WEBSOCKET code directly", () => {
    // Remove globalThis.WebSocket
    delete (globalThis as any).WebSocket;

    const origRequire = (globalThis as any).require;
    delete (globalThis as any).require;

    const client = new DanWebSocketClient("ws://127.0.0.1:19692/ws");

    // Access the private method via bracket notation
    let thrownError: any = null;
    try {
      (client as any)._getWebSocketImpl();
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeInstanceOf(DanWSError);
    expect(thrownError.code).toBe("NO_WEBSOCKET");
    expect(thrownError.message).toContain("No WebSocket implementation found");

    // Restore
    if (origRequire !== undefined) {
      (globalThis as any).require = origRequire;
    }
  });

  // ── Test 4: Client data Proxy works without Node.js APIs ──

  it("client.data returns a Proxy object", () => {
    // Use a mock WebSocket so constructor doesn't fail
    class MockWS {
      binaryType = "blob";
      readyState = 0;
      onopen: any = null;
      onclose: any = null;
      onerror: any = null;
      onmessage: any = null;
      constructor(_url: string) {}
      send(_d: any) {}
      close() {}
    }
    (globalThis as any).WebSocket = MockWS;

    const client = new DanWebSocketClient("ws://127.0.0.1:19693/ws");

    const data = client.data;

    // Verify it's a Proxy-based object (has the special "get" method and "keys" property)
    expect(typeof data).toBe("object");
    expect(data).not.toBeNull();
    expect(typeof data.get).toBe("function");
    expect(Array.isArray(data.keys)).toBe(true);
    expect(data.keys.length).toBe(0);

    // Accessing non-existent keys returns undefined (Proxy behavior)
    expect(data.nonExistentKey).toBeUndefined();

    client.disconnect();
  });

  it("client.data Proxy access works with populated store", () => {
    class MockWS {
      binaryType = "blob";
      readyState = 0;
      onopen: any = null;
      onclose: any = null;
      onerror: any = null;
      onmessage: any = null;
      constructor(_url: string) {}
      send(_d: any) {}
      close() {}
    }
    (globalThis as any).WebSocket = MockWS;

    const client = new DanWebSocketClient("ws://127.0.0.1:19693/ws");

    // Manually populate internal registry and store via private fields
    const registry = (client as any)._registry;
    const store = (client as any)._store;

    // Register keys like the server would
    registry.registerOne(1, "user.name", 4); // 4 = DataType.String
    registry.registerOne(2, "user.age", 2);  // 2 = DataType.Int32
    registry.registerOne(3, "status", 4);

    // Set values in store
    store.set(1, "Alice");
    store.set(2, 30);
    store.set(3, "active");

    const data = client.data;

    // Flat access via get()
    expect(data.get("user.name")).toBe("Alice");
    expect(data.get("user.age")).toBe(30);
    expect(data.get("status")).toBe("active");

    // Nested proxy access
    expect(data.status).toBe("active");
    expect(data.user.name).toBe("Alice");
    expect(data.user.age).toBe(30);

    client.disconnect();
  });

  // ── Test: Browser WebSocket API shape compatibility ──

  it("client works with browser-shaped WebSocket (event-based API)", () => {
    let capturedOnOpen: any = null;
    let capturedOnMessage: any = null;

    class BrowserLikeWS {
      binaryType = "blob";
      readyState = 0;

      set onopen(fn: any) { capturedOnOpen = fn; }
      get onopen() { return capturedOnOpen; }
      set onclose(_fn: any) {}
      get onclose() { return null; }
      set onerror(_fn: any) {}
      get onerror() { return null; }
      set onmessage(fn: any) { capturedOnMessage = fn; }
      get onmessage() { return capturedOnMessage; }

      constructor(_url: string) {
        // Simulate async open like a real browser WebSocket
        setTimeout(() => {
          this.readyState = 1;
          if (capturedOnOpen) capturedOnOpen({});
        }, 5);
      }

      send(_data: any) {}
      close() { this.readyState = 3; }
    }

    (globalThis as any).WebSocket = BrowserLikeWS;

    const client = new DanWebSocketClient("ws://127.0.0.1:19690/ws");
    client.connect();

    expect(client.state).toBe("connecting");

    client.disconnect();
  });
});
