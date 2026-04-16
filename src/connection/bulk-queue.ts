import { FrameType, DataType } from "../protocol/types.js";
import type { Frame } from "../protocol/types.js";
import { encodeBatch } from "../protocol/codec.js";

const DEFAULT_FLUSH_INTERVAL = 100; // ms
export const DEFAULT_MAX_QUEUE_SIZE = 50_000;

export class BulkQueue {
  private queue: Frame[] = [];
  private valueFrames = new Map<number, Frame>(); // keyId → latest value frame (dedup)
  private timer: ReturnType<typeof setTimeout> | null = null;
  private _onFlush: ((data: Uint8Array) => void) | null = null;
  private _onOverflow: (() => void) | null = null;
  private _flushInterval: number;
  private _emitFlushEnd: boolean;
  private _maxQueueSize: number;
  private _disposed = false;

  constructor(flushIntervalMs?: number, options?: { emitFlushEnd?: boolean; maxQueueSize?: number }) {
    this._flushInterval = flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL;
    this._emitFlushEnd = options?.emitFlushEnd ?? true;
    this._maxQueueSize = options?.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
  }

  onOverflow(cb: () => void): void { this._onOverflow = cb; }

  onFlush(callback: (data: Uint8Array) => void): void {
    this._onFlush = callback;
  }

  /**
   * Enqueue a frame for batched sending.
   * Value frames are deduplicated per keyId — only the latest value is kept.
   */
  enqueue(frame: Frame): void {
    if (this._disposed) return;
    const totalPending = this.queue.length + this.valueFrames.size;
    if (totalPending >= this._maxQueueSize) {
      this.dispose();
      if (this._onOverflow) { try { this._onOverflow(); } catch {} }
      return;
    }

    if (isValueFrame(frame.frameType)) {
      this.valueFrames.set(frame.keyId, frame);
    } else {
      this.queue.push(frame);
    }

    this.startTimer();
  }

  /**
   * Immediately flush all queued frames.
   */
  flush(): void {
    this.stopTimer();

    // Combine non-value frames + deduplicated value frames
    const frames = [...this.queue, ...this.valueFrames.values()];
    this.queue = [];
    this.valueFrames.clear();

    if (frames.length === 0) return;

    // Append SERVER_FLUSH_END as batch boundary signal (server direction only)
    if (this._emitFlushEnd) {
      frames.push({
        frameType: FrameType.ServerFlushEnd,
        keyId: 0, dataType: DataType.Null, payload: null,
      });
    }

    if (this._onFlush) {
      const data = encodeBatch(frames);
      this._onFlush(data);
    }
  }

  /**
   * Discard all queued frames without sending.
   */
  clear(): void {
    this.stopTimer();
    this.queue = [];
    this.valueFrames.clear();
  }

  /**
   * Discard only value frames for a specific direction.
   * Used during recovery.
   */
  clearValueFrames(): void {
    this.valueFrames.clear();
  }

  get pending(): number {
    return this.queue.length + this.valueFrames.size;
  }

  private startTimer(): void {
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, this._flushInterval);
    }
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    this.clear();
    this._onFlush = null;
  }
}

function isValueFrame(frameType: number): boolean {
  // ServerValue or ClientValue — NOT ArrayShiftLeft (0x20) / ArrayShiftRight (0x21) which must not be deduplicated
  return frameType === 0x01 || frameType === 0x03;
}
