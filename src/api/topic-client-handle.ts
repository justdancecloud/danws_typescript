import { KeyRegistry } from "../state/key-registry.js";
import { createStateProxy } from "./state-proxy.js";

export interface TopicClientPayloadView {
  get(key: string): unknown;
  readonly keys: string[];
}

export class TopicClientHandle {
  readonly name: string;
  private _index: number;
  private _registry: KeyRegistry;
  private _storeGet: (keyId: number) => unknown;

  private _onReceive: Array<(key: string, value: unknown) => void> = [];
  private _onUpdate: Array<(payload: TopicClientPayloadView) => void> = [];
  private _log: ((msg: string, err?: Error) => void) | null;
  private _cachedKeys: string[] | null = null;
  private _lastPathsRef: string[] | null = null;

  constructor(name: string, index: number, registry: KeyRegistry, storeGet: (keyId: number) => unknown, log?: (msg: string, err?: Error) => void) {
    this.name = name;
    this._index = index;
    this._registry = registry;
    this._storeGet = storeGet;
    this._log = log ?? null;
  }

  get(key: string): unknown {
    const wirePath = `t.${this._index}.${key}`;
    const entry = this._registry.getByPath(wirePath);
    if (!entry) return undefined;
    return this._storeGet(entry.keyId);
  }

  /** Get a Proxy-based data view for nested object access. */
  get data(): Record<string, any> {
    return createStateProxy(
      (key) => this.get(key),
      () => this.keys,
    );
  }

  get keys(): string[] {
    const paths = this._registry.paths;
    if (this._cachedKeys && paths === this._lastPathsRef) return this._cachedKeys;
    const prefix = `t.${this._index}.`;
    const result: string[] = [];
    for (const path of paths) {
      if (path.startsWith(prefix)) {
        result.push(path.slice(prefix.length));
      }
    }
    this._cachedKeys = result;
    this._lastPathsRef = paths;
    return result;
  }

  onReceive(cb: (key: string, value: unknown) => void): () => void {
    this._onReceive.push(cb);
    return () => { const i = this._onReceive.indexOf(cb); if (i !== -1) this._onReceive.splice(i, 1); };
  }

  onUpdate(cb: (payload: TopicClientPayloadView) => void): () => void {
    this._onUpdate.push(cb);
    return () => { const i = this._onUpdate.indexOf(cb); if (i !== -1) this._onUpdate.splice(i, 1); };
  }

  private _dirty = false;

  /** @internal — fire onReceive per-frame, mark dirty for batch onUpdate */
  _notify(userKey: string, value: unknown): void {
    for (const cb of this._onReceive) {
      try { cb(userKey, value); } catch (e) { if (this._log) this._log("topic onReceive error", e as Error); }
    }
    this._dirty = true;
  }

  /** @internal — fire onUpdate if dirty (called on SERVER_FLUSH_END) */
  _flushUpdate(): void {
    if (!this._dirty || this._onUpdate.length === 0) return;
    this._dirty = false;
    const view = this._createPayloadView();
    for (const cb of this._onUpdate) {
      try { cb(view); } catch (e) { if (this._log) this._log("topic onUpdate error", e as Error); }
    }
  }

  private _createPayloadView(): TopicClientPayloadView {
    return createStateProxy(
      (key) => this.get(key),
      () => this.keys,
    ) as any;
  }

  get _idx(): number { return this._index; }

  /** @internal — update wire index */
  _setIndex(index: number): void { this._index = index; this._cachedKeys = null; this._lastPathsRef = null; }
}
