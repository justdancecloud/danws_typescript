import { DataType, FrameType } from "../protocol/types.js";
import type { Frame } from "../protocol/types.js";
import { KeyRegistry, type KeyDefinition } from "./key-registry.js";
import { StateStore } from "./state-store.js";

/**
 * Handshake phase for one direction.
 *
 * idle        → No keys registered yet
 * registering → Keys being sent, waiting to send SYNC
 * synced      → SYNC sent, waiting for READY from remote
 * ready       → READY received, values can flow
 * recovering  → RESET sent, re-registration in progress
 */
export type HandshakePhase = "idle" | "registering" | "synced" | "ready" | "recovering";

/**
 * Manages the handshake for the "sender" side of one direction.
 *
 * - As sender (TX): we register keys, send SYNC, wait for READY, then send values.
 * - As receiver (RX): remote registers keys, sends SYNC, we send READY, then receive values.
 *
 * This class handles both roles. The `role` parameter determines which frame types to use.
 */
export type HandshakeRole = "server-to-client" | "client-to-server";

interface FrameTypeSet {
  keyReg: FrameType;
  value: FrameType;
  sync: FrameType;
  ready: FrameType;
  reset: FrameType;
  resyncReq: FrameType;
}

const SERVER_TO_CLIENT: FrameTypeSet = {
  keyReg: FrameType.ServerKeyRegistration,
  value: FrameType.ServerValue,
  sync: FrameType.ServerSync,
  ready: FrameType.ClientReady,
  reset: FrameType.ServerReset,
  resyncReq: FrameType.ClientResyncReq,
};

const CLIENT_TO_SERVER: FrameTypeSet = {
  keyReg: FrameType.ClientKeyRegistration,
  value: FrameType.ClientValue,
  sync: FrameType.ClientSync,
  ready: FrameType.ServerReady,
  reset: FrameType.ClientReset,
  resyncReq: FrameType.ServerResyncReq,
};

export class HandshakeController {
  readonly registry = new KeyRegistry();
  readonly store = new StateStore();
  private _phase: HandshakePhase = "idle";
  private _pendingRecovery = false;
  private readonly ft: FrameTypeSet;

  constructor(readonly role: HandshakeRole) {
    this.ft = role === "server-to-client" ? SERVER_TO_CLIENT : CLIENT_TO_SERVER;
  }

  get phase(): HandshakePhase {
    return this._phase;
  }

  // ──── Sender side ────

  /**
   * Generate frames for registering keys + SYNC.
   * Returns frames to be queued for sending.
   */
  buildRegistrationFrames(keys: KeyDefinition[]): Frame[] {
    this.registry.register(keys);
    this._phase = "registering";

    const frames: Frame[] = [];
    for (const entry of this.registry.entries()) {
      frames.push({
        frameType: this.ft.keyReg,
        keyId: entry.keyId,
        dataType: entry.type,
        payload: entry.path,
      });
    }
    frames.push({
      frameType: this.ft.sync,
      keyId: 0,
      dataType: DataType.Null,
      payload: null,
    });

    this._phase = "synced";
    return frames;
  }

  /**
   * Generate frames for a full reset + re-registration.
   * Used during recovery (sender-initiated) or updateKeys after initial handshake.
   */
  buildResetAndRegistrationFrames(keys: KeyDefinition[]): Frame[] {
    this._phase = "recovering";
    this.store.clear();

    const resetFrame: Frame = {
      frameType: this.ft.reset,
      keyId: 0,
      dataType: DataType.Null,
      payload: null,
    };

    const regFrames = this.buildRegistrationFrames(keys);
    return [resetFrame, ...regFrames];
  }

  /**
   * Called when READY is received from the remote side.
   * Returns value frames for full state sync (all keys with current values).
   */
  handleReady(): Frame[] {
    if (this._phase !== "synced") {
      return []; // Ignore READY without preceding SYNC
    }

    this._phase = "ready";
    this._pendingRecovery = false;

    // Build value frames for all registered keys that have values
    const frames: Frame[] = [];
    for (const entry of this.registry.entries()) {
      if (this.store.has(entry.keyId)) {
        frames.push({
          frameType: this.ft.value,
          keyId: entry.keyId,
          dataType: entry.type,
          payload: this.store.get(entry.keyId),
        });
      }
    }
    return frames;
  }

  /**
   * Build a single value frame for sending.
   */
  buildValueFrame(keyId: number, value: unknown): Frame | null {
    const entry = this.registry.getByKeyId(keyId);
    if (!entry) return null;

    this.store.set(keyId, value);

    return {
      frameType: this.ft.value,
      keyId: entry.keyId,
      dataType: entry.type,
      payload: value,
    };
  }

  // ──── Receiver side ────

  /**
   * Process an incoming key registration frame.
   */
  handleKeyRegistration(keyId: number, dataType: DataType, keyPath: string): void {
    // When receiving key registrations, we build the registry from incoming frames
    // (not from local KeyDefinition[])
  }

  /**
   * Called when the sender's SYNC is received.
   * Returns a READY frame to send back.
   */
  handleSync(): Frame {
    this._phase = "synced";
    const readyFrame: Frame = {
      frameType: this.ft.ready,
      keyId: 0,
      dataType: DataType.Null,
      payload: null,
    };
    this._phase = "ready";
    return readyFrame;
  }

  /**
   * Process an incoming RESET frame (receiver side).
   * Clears all registry and state data.
   */
  handleReset(): void {
    this.registry.clear();
    this.store.clear();
    this._phase = "idle";
  }

  /**
   * Process an incoming RESYNC_REQ frame (sender side).
   * Returns frames for reset + full re-registration.
   */
  handleResyncReq(): Frame[] | null {
    if (this._pendingRecovery) {
      return null; // Ignore duplicate RESYNC_REQ during recovery
    }

    this._pendingRecovery = true;

    const currentKeys: KeyDefinition[] = [];
    for (const entry of this.registry.entries()) {
      currentKeys.push({ path: entry.path, type: entry.type });
    }

    return this.buildResetAndRegistrationFrames(currentKeys);
  }

  /**
   * Check if a value frame can be sent in the current phase.
   */
  canSendValues(): boolean {
    return this._phase === "ready";
  }

  /**
   * Check if a value frame can be received in the current phase.
   */
  canReceiveValues(): boolean {
    return this._phase === "ready";
  }

  /**
   * Reset to idle state.
   */
  reset(): void {
    this.registry.clear();
    this.store.clear();
    this._phase = "idle";
    this._pendingRecovery = false;
  }
}
