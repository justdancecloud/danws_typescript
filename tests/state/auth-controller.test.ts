import { describe, it, expect, vi } from "vitest";
import { AuthController } from "../../src/state/auth-controller.js";
import { FrameType } from "../../src/protocol/types.js";

describe("AuthController", () => {
  const sampleUuidBytes = new Uint8Array([
    0x01, 0x9a, 0xbc, 0xde, 0xf0, 0x12, 0x70, 0x00,
    0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
  ]);

  describe("No auth required", () => {
    it("transitions directly to authorized after IDENTIFY", () => {
      const auth = new AuthController({ required: false, timeout: 5000 });
      expect(auth.phase).toBe("awaiting_identify");

      const result = auth.handleIdentify(sampleUuidBytes);
      expect(result).toBe(true);
      expect(auth.phase).toBe("authorized");
      expect(auth.isAuthorized).toBe(true);
      expect(auth.clientUuid).toBe("019abcde-f012-7000-8000-000000000001");
    });
  });

  describe("Auth required", () => {
    it("transitions to awaiting_auth after IDENTIFY", () => {
      const auth = new AuthController({ required: true, timeout: 5000 });

      auth.handleIdentify(sampleUuidBytes);
      expect(auth.phase).toBe("awaiting_auth");
      expect(auth.isAuthorized).toBe(false);
    });

    it("handleAuth returns token for verification", () => {
      const auth = new AuthController({ required: true, timeout: 5000 });
      auth.handleIdentify(sampleUuidBytes);

      const token = auth.handleAuth("my-jwt-token");
      expect(token).toBe("my-jwt-token");
      expect(auth.token).toBe("my-jwt-token");
      // Still not authorized — waiting for accept/reject
      expect(auth.isAuthorized).toBe(false);
    });

    it("accept transitions to authorized", () => {
      const auth = new AuthController({ required: true, timeout: 5000 });
      auth.handleIdentify(sampleUuidBytes);
      auth.handleAuth("token");

      const frame = auth.accept("alice");
      expect(frame.frameType).toBe(FrameType.AuthOk);
      expect(auth.phase).toBe("authorized");
      expect(auth.isAuthorized).toBe(true);
      expect(auth.principal).toBe("alice");
    });

    it("reject transitions to rejected", () => {
      const auth = new AuthController({ required: true, timeout: 5000 });
      auth.handleIdentify(sampleUuidBytes);
      auth.handleAuth("bad-token");

      const frame = auth.reject("Invalid token");
      expect(frame.frameType).toBe(FrameType.AuthFail);
      expect(frame.payload).toBe("Invalid token");
      expect(auth.phase).toBe("rejected");
      expect(auth.isAuthorized).toBe(false);
    });

    it("handleAuth returns null if not in awaiting_auth phase", () => {
      const auth = new AuthController({ required: true, timeout: 5000 });
      // Still in awaiting_identify
      expect(auth.handleAuth("token")).toBeNull();
    });
  });

  describe("IDENTIFY validation", () => {
    it("rejects non-16-byte payload", () => {
      const auth = new AuthController({ required: false, timeout: 5000 });
      expect(auth.handleIdentify(new Uint8Array(10))).toBe(false);
      expect(auth.phase).toBe("awaiting_identify");
    });

    it("rejects double IDENTIFY", () => {
      const auth = new AuthController({ required: false, timeout: 5000 });
      auth.handleIdentify(sampleUuidBytes);
      // Already authorized, second IDENTIFY ignored
      expect(auth.handleIdentify(sampleUuidBytes)).toBe(false);
    });
  });

  describe("Timeout", () => {
    it("fires timeout callback when auth not received", () => {
      vi.useFakeTimers();
      const auth = new AuthController({ required: true, timeout: 5000 });
      auth.handleIdentify(sampleUuidBytes);

      const onTimeout = vi.fn();
      auth.startTimeout(onTimeout);

      vi.advanceTimersByTime(4999);
      expect(onTimeout).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(onTimeout).toHaveBeenCalledOnce();

      vi.useRealTimers();
    });

    it("accept cancels timeout", () => {
      vi.useFakeTimers();
      const auth = new AuthController({ required: true, timeout: 5000 });
      auth.handleIdentify(sampleUuidBytes);

      const onTimeout = vi.fn();
      auth.startTimeout(onTimeout);

      auth.handleAuth("token");
      auth.accept("alice");

      vi.advanceTimersByTime(10000);
      expect(onTimeout).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("reject cancels timeout", () => {
      vi.useFakeTimers();
      const auth = new AuthController({ required: true, timeout: 5000 });
      auth.handleIdentify(sampleUuidBytes);

      const onTimeout = vi.fn();
      auth.startTimeout(onTimeout);

      auth.handleAuth("token");
      auth.reject("no");

      vi.advanceTimersByTime(10000);
      expect(onTimeout).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe("Static frame builders", () => {
    it("buildIdentifyFrame", () => {
      const frame = AuthController.buildIdentifyFrame("019abcde-f012-7000-8000-000000000001");
      expect(frame.frameType).toBe(FrameType.Identify);
      const payload = frame.payload as Uint8Array;
      expect(payload.length).toBe(18); // 16 UUID + 2 version
      expect(payload.subarray(0, 16)).toEqual(sampleUuidBytes);
      expect(payload[16]).toBe(AuthController.PROTOCOL_VERSION[0]); // major
      expect(payload[17]).toBe(AuthController.PROTOCOL_VERSION[1]); // minor
    });

    it("buildAuthFrame", () => {
      const frame = AuthController.buildAuthFrame("my-token");
      expect(frame.frameType).toBe(FrameType.Auth);
      expect(frame.payload).toBe("my-token");
    });
  });

  describe("Reset", () => {
    it("resets to initial state", () => {
      const auth = new AuthController({ required: true, timeout: 5000 });
      auth.handleIdentify(sampleUuidBytes);
      auth.handleAuth("token");
      auth.accept("alice");

      auth.reset();
      expect(auth.phase).toBe("awaiting_identify");
      expect(auth.clientUuid).toBeNull();
      expect(auth.principal).toBeNull();
      expect(auth.isAuthorized).toBe(false);
    });
  });
});
