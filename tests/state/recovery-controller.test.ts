import { describe, it, expect } from "vitest";
import { RecoveryController } from "../../src/state/recovery-controller.js";
import { FrameType } from "../../src/protocol/types.js";

describe("RecoveryController", () => {
  it("triggerResync returns RESYNC_REQ frame", () => {
    const rc = new RecoveryController();
    const frame = rc.triggerResync(FrameType.ClientResyncReq);

    expect(frame).not.toBeNull();
    expect(frame!.frameType).toBe(FrameType.ClientResyncReq);
    expect(rc.isRecovering).toBe(true);
  });

  it("ignores duplicate triggerResync during recovery", () => {
    const rc = new RecoveryController();
    rc.triggerResync(FrameType.ClientResyncReq);

    const second = rc.triggerResync(FrameType.ClientResyncReq);
    expect(second).toBeNull();
  });

  it("complete allows new recovery", () => {
    const rc = new RecoveryController();
    rc.triggerResync(FrameType.ClientResyncReq);
    rc.complete();

    expect(rc.isRecovering).toBe(false);

    const frame = rc.triggerResync(FrameType.ClientResyncReq);
    expect(frame).not.toBeNull();
  });

  it("server direction uses ServerResyncReq", () => {
    const rc = new RecoveryController();
    const frame = rc.triggerResync(FrameType.ServerResyncReq);

    expect(frame!.frameType).toBe(FrameType.ServerResyncReq);
  });

  it("reset clears recovering state", () => {
    const rc = new RecoveryController();
    rc.triggerResync(FrameType.ClientResyncReq);
    rc.reset();

    expect(rc.isRecovering).toBe(false);
  });
});
