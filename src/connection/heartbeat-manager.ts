import { encodeHeartbeat } from "../protocol/codec.js";

const SEND_INTERVAL = 10_000; // 10 seconds
const TIMEOUT_THRESHOLD = 15_000; // 15 seconds

export class HeartbeatManager {
  private sendTimer: ReturnType<typeof setInterval> | null = null;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private lastReceived = 0;
  private _onSend: ((data: Uint8Array) => void) | null = null;
  private _onTimeout: (() => void) | null = null;

  onSend(callback: (data: Uint8Array) => void): void {
    this._onSend = callback;
  }

  onTimeout(callback: () => void): void {
    this._onTimeout = callback;
  }

  start(): void {
    this.stop();
    this.lastReceived = Date.now();

    // Send heartbeat every 10s
    this.sendTimer = setInterval(() => {
      if (this._onSend) {
        this._onSend(encodeHeartbeat());
      }
    }, SEND_INTERVAL);

    // Check for timeout every 5 seconds (threshold is 15s, so detection within 15-20s)
    this.timeoutTimer = setInterval(() => {
      if (Date.now() - this.lastReceived > TIMEOUT_THRESHOLD) {
        this.stop();
        if (this._onTimeout) {
          this._onTimeout();
        }
      }
    }, 5000);
  }

  /**
   * Called when a heartbeat is received from the remote side.
   */
  received(): void {
    this.lastReceived = Date.now();
  }

  stop(): void {
    if (this.sendTimer !== null) {
      clearInterval(this.sendTimer);
      this.sendTimer = null;
    }
    if (this.timeoutTimer !== null) {
      clearInterval(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  get isRunning(): boolean {
    return this.sendTimer !== null;
  }

  dispose(): void {
    this.stop();
    this._onSend = null;
    this._onTimeout = null;
  }
}
