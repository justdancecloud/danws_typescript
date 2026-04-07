import type { Frame } from "../protocol/types.js";
import { FlatStateManager } from "./flat-state-manager.js";
import type { DanWebSocketSession } from "./session.js";

export enum EventType {
  SubscribeEvent = "subscribe",
  ChangedParamsEvent = "changed_params",
  DelayedTaskEvent = "delayed_task",
}

export type TopicCallback = (event: EventType, topic: TopicHandle, session: DanWebSocketSession) => void | Promise<void>;

export class TopicPayload {
  private _index: number;
  private _allocateKeyId: () => number;
  private _flatState: FlatStateManager;

  constructor(index: number, allocateKeyId: () => number) {
    this._index = index;
    this._allocateKeyId = allocateKeyId;
    this._flatState = new FlatStateManager({
      allocateKeyId,
      enqueue: () => {},
      onResync: () => {},
      wirePrefix: `t.${index}.`,
    });
  }

  /** @internal */
  _bind(enqueue: (frame: Frame) => void, onResync: () => void): void {
    this._flatState = new FlatStateManager({
      allocateKeyId: this._allocateKeyId,
      enqueue,
      onResync,
      wirePrefix: `t.${this._index}.`,
    });
  }

  set(key: string, value: unknown): void { this._flatState.set(key, value); }
  get(key: string): unknown { return this._flatState.get(key); }
  get keys(): string[] { return this._flatState.keys; }

  clear(key?: string): void {
    if (key !== undefined) {
      this._flatState.clear(key);
    } else {
      this._flatState.clear();
    }
  }

  /** @internal */
  _buildKeyFrames(): Frame[] { return this._flatState.buildKeyFrames(); }
  /** @internal */
  _buildValueFrames(): Frame[] { return this._flatState.buildValueFrames(); }

  get _size(): number { return this._flatState.size; }
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
    try {
      const r = fn(EventType.SubscribeEvent, this, this._session);
      if (r instanceof Promise) r.catch((e) => console.warn("[dan-ws] topic callback error", e));
    } catch (e) {
      console.warn("[dan-ws] topic setCallback error", e);
    }
  }

  setDelayedTask(ms: number): void {
    this.clearDelayedTask();
    this._delayMs = ms;
    this._timer = setInterval(() => {
      if (this._callback) {
        try {
          const r = this._callback(EventType.DelayedTaskEvent, this, this._session);
          if (r instanceof Promise) r.catch((e) => console.warn("[dan-ws] delayed task error", e));
        } catch (e) {
          console.warn("[dan-ws] delayed task error", e);
        }
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
      try {
        const r = this._callback(EventType.ChangedParamsEvent, this, this._session);
        if (r instanceof Promise) r.catch((e) => console.warn("[dan-ws] params change callback error", e));
      } catch (e) {
        console.warn("[dan-ws] params change callback error", e);
      }
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
