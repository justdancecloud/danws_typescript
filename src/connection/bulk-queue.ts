import { FrameType, DataType } from "../protocol/types.js";
import type { Frame } from "../protocol/types.js";
import { encodeBatch } from "../protocol/codec.js";

const DEFAULT_FLUSH_INTERVAL = 100; // ms

export class BulkQueue {
  private queue: Frame[] = [];
  private valueFrames = new Map<number, Frame>(); // keyId → latest value frame (dedup)
  private timer: ReturnType<typeof setTimeout> | null = null;
  private _onFlush: ((data: Uint8Array) => void) | null = null;
  private _flushInterval: number;

  constructor(flushIntervalMs?: number) {
    this._flushInterval = flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL;
  }

  onFlush(callback: (data: Uint8Array) => void): void {
    this._onFlush = callback;
  }

  /**
   * Enqueue a frame for batched sending.
   * Value frames are deduplicated per keyId — only the latest value is kept.
   */
  enqueue(frame: Frame): void {
    if (isValueFrame(frame.frameType)) {
      // Dedup: replace previous value for same keyId
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

    // Append SERVER_FLUSH_END as batch boundary signal
    frames.push({
      frameType: FrameType.ServerFlushEnd,
      keyId: 0, dataType: DataType.Null, payload: null,
    });

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
