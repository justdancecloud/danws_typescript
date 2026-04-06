import { DataType, FrameType } from "../protocol/types.js";
import type { Frame } from "../protocol/types.js";
import { serialize } from "../protocol/serializer.js";
import { detectDataType } from "../protocol/auto-type.js";
import { validateKeyPath } from "../state/key-registry.js";
import { flattenValue, shouldFlatten } from "./flatten.js";
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
  private _index: number;
  private _allocateKeyId: () => number;
  private _enqueue: ((frame: Frame) => void) | null = null;
  private _onResync: (() => void) | null = null;
  private _flattenedKeys = new Map<string, Set<string>>();
  private _wirePathCache = new Map<string, string>();
  private _previousArrays = new Map<string, unknown[]>();

  constructor(index: number, allocateKeyId: () => number) {
    this._index = index;
    this._allocateKeyId = allocateKeyId;
  }

  /** @internal */
  _bind(enqueue: (frame: Frame) => void, onResync: () => void): void {
    this._enqueue = enqueue;
    this._onResync = onResync;
  }

  set(key: string, value: unknown): void {
    if (shouldFlatten(value)) {
      // Array shift detection for array values
      if (Array.isArray(value)) {
        const oldArr = this._previousArrays.get(key);
        // Only use shift optimization for arrays of primitives
        const hasPrimitiveElements = value.length === 0 || !shouldFlatten(value[0]);
        if (hasPrimitiveElements && oldArr && oldArr.length > 0 && value.length > 0) {
          const shift = detectArrayShiftBoth(oldArr, value);
          if (shift.direction === "left") {
            this._applyArrayShiftLeft(key, oldArr, value, shift.count);
            return;
          }
          if (shift.direction === "right") {
            this._applyArrayShiftRight(key, oldArr, value, shift.count);
            return;
          }
        }
        this._previousArrays.set(key, [...value]);
      }

      const flattened = flattenValue(key, value);
      const newKeys = new Set(flattened.keys());
      const oldKeys = this._flattenedKeys.get(key);
      let needsResync = false;
      if (oldKeys) {
        for (const oldPath of oldKeys) {
          if (!newKeys.has(oldPath)) {
            if (isArrayIndexKey(key, oldPath)) continue; // stale array index — client uses .length
            this._entries.delete(oldPath);
            this._wirePathCache.delete(oldPath);
            needsResync = true;
          }
        }
      }
      this._flattenedKeys.set(key, newKeys);
      for (const [path, leaf] of flattened) {
        if (this._setLeafInternal(path, leaf)) needsResync = true;
      }
      if (needsResync && this._onResync) this._onResync();
      return;
    }
    this._setLeafDirect(key, value);
  }

  private _applyArrayShiftLeft(key: string, oldArr: unknown[], newArr: unknown[], shiftCount: number): void {
    const oldLen = oldArr.length;
    const newLen = newArr.length;

    // 1. Send ARRAY_SHIFT_LEFT frame
    const lengthEntry = this._entries.get(key + ".length");
    if (lengthEntry && this._enqueue) {
      this._enqueue({
        frameType: FrameType.ArrayShiftLeft,
        keyId: lengthEntry.keyId,
        dataType: DataType.Int32,
        payload: shiftCount,
      });
    }

    // 2. Silently update internal store for shifted indices (low to high)
    for (let i = 0; i < newLen && i < oldLen - shiftCount; i++) {
      const entry = this._entries.get(`${key}.${i}`);
      if (entry) {
        entry.value = newArr[i];
      }
    }

    // 3. Send new tail elements
    const existingAfterShift = oldLen - shiftCount;
    for (let i = existingAfterShift; i < newLen; i++) {
      const elem = newArr[i];
      if (shouldFlatten(elem)) {
        const elemFlat = flattenValue(`${key}.${i}`, elem);
        for (const [path, leaf] of elemFlat) this._setLeafInternal(path, leaf);
      } else {
        this._setLeafDirect(`${key}.${i}`, elem);
      }
    }

    // 4. Always send length — client decrements length on ArrayShiftLeft,
    //    so we must send the correct final length to restore it.
    //    Force-send even when newLen === oldLen.
    const lenEntry = this._entries.get(key + ".length");
    if (lenEntry && this._enqueue) {
      lenEntry.value = newLen;
      const wirePath = this._wirePathCache.get(key + ".length") ?? `t.${this._index}.${key}.length`;
      this._enqueue({
        frameType: FrameType.ServerValue,
        keyId: lenEntry.keyId,
        dataType: lenEntry.type,
        payload: newLen,
      });
    }

    // 5. Update flattenedKeys
    const flattened = flattenValue(key, newArr);
    this._flattenedKeys.set(key, new Set(flattened.keys()));

    // 6. Update previousArrays
    this._previousArrays.set(key, [...newArr]);
  }

  private _applyArrayShiftRight(key: string, oldArr: unknown[], newArr: unknown[], shiftCount: number): void {
    const oldLen = oldArr.length;
    const newLen = newArr.length;

    // 1. Send ARRAY_SHIFT_RIGHT frame
    const lengthEntry = this._entries.get(key + ".length");
    if (lengthEntry && this._enqueue) {
      this._enqueue({
        frameType: FrameType.ArrayShiftRight,
        keyId: lengthEntry.keyId,
        dataType: DataType.Int32,
        payload: shiftCount,
      });
    }

    // 2. Silently update internal store for shifted indices (high to low)
    for (let i = oldLen - 1; i >= 0; i--) {
      const srcEntry = this._entries.get(`${key}.${i}`);
      const dstEntry = this._entries.get(`${key}.${i + shiftCount}`);
      if (srcEntry && dstEntry) {
        dstEntry.value = oldArr[i];
      }
    }

    // 3. Send new head elements (indices 0..shiftCount-1)
    for (let i = 0; i < shiftCount; i++) {
      const elem = newArr[i];
      if (shouldFlatten(elem)) {
        const elemFlat = flattenValue(`${key}.${i}`, elem);
        for (const [path, leaf] of elemFlat) this._setLeafInternal(path, leaf);
      } else {
        this._setLeafDirect(`${key}.${i}`, elem);
      }
    }

    // 3b. Send overflow tail elements (old elements shifted beyond old bounds)
    for (let i = oldLen; i < newLen; i++) {
      const elem = newArr[i];
      if (shouldFlatten(elem)) {
        const elemFlat = flattenValue(`${key}.${i}`, elem);
        for (const [path, leaf] of elemFlat) this._setLeafInternal(path, leaf);
      } else {
        this._setLeafDirect(`${key}.${i}`, elem);
      }
    }

    // 4. Update length if changed
    if (newLen !== oldLen) {
      this._setLeafDirect(key + ".length", newLen);
    }

    // 5. Update flattenedKeys
    const flattened = flattenValue(key, newArr);
    this._flattenedKeys.set(key, new Set(flattened.keys()));

    // 6. Update previousArrays
    this._previousArrays.set(key, [...newArr]);
  }

  /** Set leaf, return true if a resync is needed (new key or type change). */
  private _setLeafInternal(key: string, value: unknown): boolean {
    validateKeyPath(key);
    const newType = detectDataType(value);
    serialize(newType, value);

    const existing = this._entries.get(key);

    if (!existing) {
      const entry: PayloadEntry = { keyId: this._allocateKeyId(), type: newType, value };
      this._entries.set(key, entry);
      if (this._enqueue) {
        const wirePath = this._wirePathCache.get(key) ?? (() => { const p = `t.${this._index}.${key}`; this._wirePathCache.set(key, p); return p; })();
        this._enqueue({ frameType: FrameType.ServerKeyRegistration, keyId: entry.keyId, dataType: entry.type, payload: wirePath });
        this._enqueue({ frameType: FrameType.ServerSync, keyId: 0, dataType: DataType.Null, payload: null });
        this._enqueue({ frameType: FrameType.ServerValue, keyId: entry.keyId, dataType: entry.type, payload: entry.value });
      }
      return false;  // sent incrementally, no resync needed
    }

    if (existing.type !== newType) {
      existing.type = newType;
      existing.value = value;
      return true;
    }

    if (existing.value === value) return false;

    existing.value = value;
    if (this._enqueue) {
      this._enqueue({
        frameType: FrameType.ServerValue,
        keyId: existing.keyId,
        dataType: existing.type,
        payload: value,
      });
    }
    return false;
  }

  private _setLeafDirect(key: string, value: unknown): void {
    validateKeyPath(key);
    const newType = detectDataType(value);
    serialize(newType, value);

    const existing = this._entries.get(key);

    if (!existing) {
      const entry: PayloadEntry = { keyId: this._allocateKeyId(), type: newType, value };
      this._entries.set(key, entry);
      if (this._enqueue) {
        const wirePath = this._wirePathCache.get(key) ?? (() => { const p = `t.${this._index}.${key}`; this._wirePathCache.set(key, p); return p; })();
        this._enqueue({ frameType: FrameType.ServerKeyRegistration, keyId: entry.keyId, dataType: entry.type, payload: wirePath });
        this._enqueue({ frameType: FrameType.ServerSync, keyId: 0, dataType: DataType.Null, payload: null });
        this._enqueue({ frameType: FrameType.ServerValue, keyId: entry.keyId, dataType: entry.type, payload: entry.value });
      }
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
      const flatKeys = this._flattenedKeys.get(key);
      if (flatKeys) {
        for (const path of flatKeys) {
          this._entries.delete(path);
          this._wirePathCache.delete(path);
        }
        this._flattenedKeys.delete(key);
        this._wirePathCache.delete(key);
        if (this._onResync) this._onResync();
      } else if (this._entries.delete(key)) {
        this._wirePathCache.delete(key);
        if (this._onResync) this._onResync();
      }
    } else {
      if (this._entries.size > 0) {
        this._entries.clear();
        this._flattenedKeys.clear();
        this._wirePathCache.clear();
        if (this._onResync) this._onResync();
      }
    }
  }

  /** @internal — build key registration frames with wire prefix t.<index>.<key> */
  _buildKeyFrames(): Frame[] {
    const frames: Frame[] = [];
    for (const [key, entry] of this._entries) {
      let wirePath = this._wirePathCache.get(key);
      if (!wirePath) {
        wirePath = `t.${this._index}.${key}`;
        this._wirePathCache.set(key, wirePath);
      }
      frames.push({
        frameType: FrameType.ServerKeyRegistration,
        keyId: entry.keyId,
        dataType: entry.type,
        payload: wirePath,
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
    try { const r = fn(EventType.SubscribeEvent, this, this._session); if (r instanceof Promise) r.catch(() => {}); } catch {}
  }

  setDelayedTask(ms: number): void {
    this.clearDelayedTask();
    this._delayMs = ms;
    this._timer = setInterval(() => {
      if (this._callback) {
        try { const r = this._callback(EventType.DelayedTaskEvent, this, this._session); if (r instanceof Promise) r.catch(() => {}); } catch {}
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
      try { const r = this._callback(EventType.ChangedParamsEvent, this, this._session); if (r instanceof Promise) r.catch(() => {}); } catch {}
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

interface ShiftResult {
  direction: "left" | "right" | "none";
  count: number;
}

function detectArrayShiftBoth(oldArr: unknown[], newArr: unknown[]): ShiftResult {
  const oldLen = oldArr.length;
  const newLen = newArr.length;

  // 1. Left shift: find new[0] in oldArr → gives shift amount k
  const newFirst = newArr[0];
  for (let k = 1; k < oldLen; k++) {
    if (oldArr[k] !== newFirst) continue;
    const matchLen = Math.min(oldLen - k, newLen);
    if (matchLen <= 0) continue;
    let match = true;
    for (let i = 1; i < matchLen; i++) {
      if (oldArr[i + k] !== newArr[i]) { match = false; break; }
    }
    if (match) return { direction: "left", count: k };
  }

  // 2. Right shift: find old[0] in newArr → gives shift amount k
  const oldFirst = oldArr[0];
  for (let k = 1; k < newLen; k++) {
    if (newArr[k] !== oldFirst) continue;
    const matchLen = Math.min(oldLen, newLen - k);
    if (matchLen <= 0) continue;
    let match = true;
    for (let i = 1; i < matchLen; i++) {
      if (oldArr[i] !== newArr[i + k]) { match = false; break; }
    }
    if (match) return { direction: "right", count: k };
  }

  return { direction: "none", count: 0 };
}

function isArrayIndexKey(prefix: string, path: string): boolean {
  if (!path.startsWith(prefix + '.')) return false;
  const suffix = path.slice(prefix.length + 1);
  return suffix.length > 0 && /^\d+$/.test(suffix);
}
