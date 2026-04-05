import { DataType, FrameType } from "../protocol/types.js";
import type { Frame } from "../protocol/types.js";

/**
 * Manages recovery state for one direction.
 * Recovery is triggered when a Value frame references an unknown Key ID.
 */
export class RecoveryController {
  private _recovering = false;

  get isRecovering(): boolean {
    return this._recovering;
  }

  /**
   * Trigger recovery (receiver side).
   * Returns RESYNC_REQ frame, or null if already recovering.
   */
  triggerResync(resyncReqFrameType: FrameType): Frame | null {
    if (this._recovering) {
      return null; // Ignore duplicate RESYNC during recovery
    }

    this._recovering = true;

    return {
      frameType: resyncReqFrameType,
      keyId: 0,
      dataType: DataType.Null,
      payload: null,
    };
  }

  /**
   * Mark recovery as complete (after READY received/sent following re-registration).
   */
  complete(): void {
    this._recovering = false;
  }

  reset(): void {
    this._recovering = false;
  }
}
