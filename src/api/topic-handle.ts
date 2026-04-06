import { DataType, FrameType } from "../protocol/types.js";
import type { Frame } from "../protocol/types.js";
import { serialize } from "../protocol/serializer.js";
import { detectDataType } from "../protocol/auto-type.js";
import { validateKeyPath } from "../state/key-registry.js";
import type { DanWebSocketSession } from "./session.js";

export enum EventType {
  SubscribeEvent = "subscribe",
  ChangedParamsEvent = "changed_params",
  DelayedTaskEvent = "delayed_task",
}

export type TopicCallback = (event: EventType, topic: TopicHandle, session: DanWebSocketSession) => void | Promise<void>;

interface PayloadEntry {
  keyId: number;
  type: DataType;
  value: unknown;
}

export class TopicPayload {
  private _entries = new Map<string, PayloadEntry>();
  private _nextKeyId: number;
  private _index: number;
  private _enqueue: ((frame: Frame) => void) | null = null;
  private _onResync: (() => void) | null = null;

  constructor(index: number) {
    this._index = index;
    this._nextKeyId = index * 10000 + 1; // avoid keyId collisions between topics
  }

  /** @internal */
  _bind(enqueue: (frame: Frame) => void, onResync: () => void): void {
    this._enqueue = enqueue;
    this._onResync = onResync;
  }

  set(key: string, value: unknown): void {
    validateKeyPath(key);
    const newType = detectDataType(value);
    serialize(newType, value);

    const existing = this._entries.get(key);

    if (!existing) {
      const entry: PayloadEntry = { keyId: this._nextKeyId++, type: newType, value };
      this._entries.set(key, entry);
      if (this._onResync) this._onResync();
      return;
    }

    if (existing.type !== newType) {
      existing.type = newType;
      existing.value = value;
      if (this._onResync) this._onResync();
      return;
    }

    // Same value — skip push
    if (existing.value === value) return;

    existing.value = value;
    if (this._enqueue) {
      this._enqueue({
        frameType: FrameType.ServerValue,
        keyId: existing.keyId,
        dataType: existing.type,
        payload: value,
      });
    }
  }

  get(key: string): unknown {
    const entry = this._entries.get(key);
    return entry ? entry.value : undefined;
  }

  get keys(): string[] {
    return Array.from(this._entries.keys());
  }

  clear(key?: string): void {
    if (key !== undefined) {
      if (this._entries.delete(key)) {
        if (this._onResync) this._onResync();
      }
    } else {
      if (this._entries.size > 0) {
        this._entries.clear();
        if (this._onResync) this._onResync();
      }
    }
  }

  /** @internal — build key registration frames with wire prefix t.<index>.<key> */
  _buildKeyFrames(): Frame[] {
    const frames: Frame[] = [];
    for (const [key, entry] of this._entries) {
      frames.push({
        frameType: FrameType.ServerKeyRegistration,
        keyId: entry.keyId,
        dataType: entry.type,
        payload: `t.${this._index}.${key}`,
      });
    }
    return frames;
  }

  /** @internal */
  _buildValueFrames(): Frame[] {
    const frames: Frame[] = [];
    for (const entry of this._entries.values()) {
      if (entry.value !== undefined) {
        frames.push({
          frameType: FrameType.ServerValue,
          keyId: entry.keyId,
          dataType: entry.type,
          payload: entry.value,
        });
      }
    }
    return frames;
  }

  get _size(): number { return this._entries.size; }
  get _idx(): number { return this._index; }
}

export class TopicHandle {
  readonly name: string;
  readonly payload: TopicPayload;

  private _params: Record<string, unknown>;
  private _callback: TopicCallback | null = null;
  private _session: DanWebSocketSession;
  private _delayMs: number | null = null;
  private _timer: ReturnType<typeof setInterval> | null = null;

  constructor(name: string, params: Record<string, unknown>, payload: TopicPayload, session: DanWebSocketSession) {
    this.name = name;
    this._params = params;
    this.payload = payload;
    this._session = session;
  }

  get params(): Record<string, unknown> { return this._params; }

  setCallback(fn: TopicCallback): void {
    this._callback = fn;
    // Run immediately with SubscribeEvent
    try { fn(EventType.SubscribeEvent, this, this._session); } catch {}
  }

  setDelayedTask(ms: number): void {
    this.clearDelayedTask();
    this._delayMs = ms;
    this._timer = setInterval(() => {
      if (this._callback) {
        try { this._callback(EventType.DelayedTaskEvent, this, this._session); } catch {}
      }
    }, ms);
  }

  clearDelayedTask(): void {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /** @internal — update params: pause task → fire callback → resume task */
  _updateParams(newParams: Record<string, unknown>): void {
    this._params = newParams;
    const hadTask = this._timer !== null;
    const savedMs = this._delayMs;

    this.clearDelayedTask();

    if (this._callback) {
      try { this._callback(EventType.ChangedParamsEvent, this, this._session); } catch {}
    }

    if (hadTask && savedMs !== null) {
      this.setDelayedTask(savedMs);
    }
  }

  /** @internal — clean up timers and references */
  _dispose(): void {
    this.clearDelayedTask();
    this._callback = null;
    this._delayMs = null;
  }
}
