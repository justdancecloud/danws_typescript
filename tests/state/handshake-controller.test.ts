import { describe, it, expect } from "vitest";
import { HandshakeController } from "../../src/state/handshake-controller.js";
import { DataType, FrameType } from "../../src/protocol/types.js";

describe("HandshakeController", () => {
  describe("Server→Client direction (sender side)", () => {
    it("builds registration frames + SYNC", () => {
      const hc = new HandshakeController("server-to-client");
      const frames = hc.buildRegistrationFrames([
        { path: "root.alive", type: DataType.Bool },
        { path: "root.name", type: DataType.String },
      ]);

      expect(frames).toHaveLength(3); // 2 key reg + 1 SYNC
      expect(frames[0].frameType).toBe(FrameType.ServerKeyRegistration);
      expect(frames[0].keyId).toBe(1);
      expect(frames[0].payload).toBe("root.alive");
      expect(frames[1].frameType).toBe(FrameType.ServerKeyRegistration);
      expect(frames[1].keyId).toBe(2);
      expect(frames[2].frameType).toBe(FrameType.ServerSync);
      expect(hc.phase).toBe("synced");
    });

    it("handleReady transitions to ready and returns value frames", () => {
      const hc = new HandshakeController("server-to-client");
      hc.buildRegistrationFrames([
        { path: "root.alive", type: DataType.Bool },
        { path: "root.name", type: DataType.String },
      ]);

      // Set some values before READY
      hc.store.set(1, true);
      hc.store.set(2, "Alice");

      const valueFrames = hc.handleReady();
      expect(hc.phase).toBe("ready");
      expect(valueFrames).toHaveLength(2);
      expect(valueFrames[0].frameType).toBe(FrameType.ServerValue);
      expect(valueFrames[0].keyId).toBe(1);
      expect(valueFrames[0].payload).toBe(true);
      expect(valueFrames[1].payload).toBe("Alice");
    });

    it("handleReady returns empty if no values set", () => {
      const hc = new HandshakeController("server-to-client");
      hc.buildRegistrationFrames([{ path: "root.alive", type: DataType.Bool }]);

      const valueFrames = hc.handleReady();
      expect(valueFrames).toHaveLength(0);
      expect(hc.phase).toBe("ready");
    });

    it("ignores READY without preceding SYNC", () => {
      const hc = new HandshakeController("server-to-client");
      // Phase is "idle", not "synced"
      const result = hc.handleReady();
      expect(result).toHaveLength(0);
      expect(hc.phase).toBe("idle");
    });

    it("canSendValues only when ready", () => {
      const hc = new HandshakeController("server-to-client");
      expect(hc.canSendValues()).toBe(false);

      hc.buildRegistrationFrames([{ path: "x", type: DataType.Bool }]);
      expect(hc.canSendValues()).toBe(false); // synced, not ready

      hc.handleReady();
      expect(hc.canSendValues()).toBe(true);
    });

    it("buildValueFrame creates correct frame", () => {
      const hc = new HandshakeController("server-to-client");
      hc.buildRegistrationFrames([{ path: "root.temp", type: DataType.Float32 }]);
      hc.handleReady();

      const frame = hc.buildValueFrame(1, 23.5);
      expect(frame).not.toBeNull();
      expect(frame!.frameType).toBe(FrameType.ServerValue);
      expect(frame!.keyId).toBe(1);
      expect(frame!.dataType).toBe(DataType.Float32);
      expect(frame!.payload).toBe(23.5);

      // Value should be stored
      expect(hc.store.get(1)).toBe(23.5);
    });

    it("buildValueFrame returns null for unknown keyId", () => {
      const hc = new HandshakeController("server-to-client");
      hc.buildRegistrationFrames([{ path: "x", type: DataType.Bool }]);
      expect(hc.buildValueFrame(999, true)).toBeNull();
    });
  });

  describe("Client→Server direction (sender side)", () => {
    it("uses client frame types", () => {
      const hc = new HandshakeController("client-to-server");
      const frames = hc.buildRegistrationFrames([
        { path: "input.x", type: DataType.Float32 },
      ]);

      expect(frames[0].frameType).toBe(FrameType.ClientKeyRegistration);
      expect(frames[1].frameType).toBe(FrameType.ClientSync);
    });

    it("handleReady uses client value type", () => {
      const hc = new HandshakeController("client-to-server");
      hc.buildRegistrationFrames([{ path: "input.x", type: DataType.Float32 }]);
      hc.store.set(1, -0.75);

      const frames = hc.handleReady();
      expect(frames[0].frameType).toBe(FrameType.ClientValue);
    });
  });

  describe("Receiver side", () => {
    it("handleSync returns READY frame (server→client, client is receiver)", () => {
      const hc = new HandshakeController("server-to-client");
      const readyFrame = hc.handleSync();

      expect(readyFrame.frameType).toBe(FrameType.ClientReady);
      expect(hc.phase).toBe("ready");
    });

    it("handleSync returns READY frame (client→server, server is receiver)", () => {
      const hc = new HandshakeController("client-to-server");
      const readyFrame = hc.handleSync();

      expect(readyFrame.frameType).toBe(FrameType.ServerReady);
      expect(hc.phase).toBe("ready");
    });

    it("handleReset clears registry and state", () => {
      const hc = new HandshakeController("server-to-client");
      hc.buildRegistrationFrames([{ path: "x", type: DataType.Bool }]);
      hc.store.set(1, true);

      hc.handleReset();
      expect(hc.registry.size).toBe(0);
      expect(hc.store.has(1)).toBe(false);
      expect(hc.phase).toBe("idle");
    });
  });

  describe("Recovery (sender side)", () => {
    it("handleResyncReq returns reset + re-registration frames", () => {
      const hc = new HandshakeController("server-to-client");
      hc.buildRegistrationFrames([
        { path: "a", type: DataType.Bool },
        { path: "b", type: DataType.String },
      ]);
      hc.handleReady();

      const frames = hc.handleResyncReq();
      expect(frames).not.toBeNull();
      // RESET + 2 key reg + SYNC
      expect(frames!).toHaveLength(4);
      expect(frames![0].frameType).toBe(FrameType.ServerReset);
      expect(frames![1].frameType).toBe(FrameType.ServerKeyRegistration);
      expect(frames![2].frameType).toBe(FrameType.ServerKeyRegistration);
      expect(frames![3].frameType).toBe(FrameType.ServerSync);
    });

    it("ignores duplicate RESYNC_REQ during recovery", () => {
      const hc = new HandshakeController("server-to-client");
      hc.buildRegistrationFrames([{ path: "a", type: DataType.Bool }]);
      hc.handleReady();

      const first = hc.handleResyncReq();
      expect(first).not.toBeNull();

      // Still recovering (synced, waiting for READY)
      const second = hc.handleResyncReq();
      expect(second).toBeNull();
    });

    it("recovery completes after READY", () => {
      const hc = new HandshakeController("server-to-client");
      hc.buildRegistrationFrames([{ path: "a", type: DataType.Bool }]);
      hc.handleReady();

      hc.store.set(1, true);
      hc.handleResyncReq();
      // Now in "synced" phase after re-registration

      const valueFrames = hc.handleReady();
      expect(hc.phase).toBe("ready");
      // Values should be cleared during reset, so no value frames
      expect(valueFrames).toHaveLength(0);
    });
  });

  describe("Reset", () => {
    it("reset returns to idle", () => {
      const hc = new HandshakeController("server-to-client");
      hc.buildRegistrationFrames([{ path: "x", type: DataType.Bool }]);
      hc.handleReady();

      hc.reset();
      expect(hc.phase).toBe("idle");
      expect(hc.registry.size).toBe(0);
    });
  });
});
