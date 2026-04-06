import { KeyRegistry } from "../state/key-registry.js";

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

  constructor(name: string, index: number, registry: KeyRegistry, storeGet: (keyId: number) => unknown) {
    this.name = name;
    this._index = index;
    this._registry = registry;
    this._storeGet = storeGet;
  }

  get(key: string): unknown {
    const wirePath = `t.${this._index}.${key}`;
    const entry = this._registry.getByPath(wirePath);
    if (!entry) return undefined;
    return this._storeGet(entry.keyId);
  }

  get keys(): string[] {
    const prefix = `t.${this._index}.`;
    const result: string[] = [];
    for (const path of this._registry.paths) {
      if (path.startsWith(prefix)) {
        result.push(path.slice(prefix.length));
      }
    }
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

  /** @internal — fire callbacks for a key update */
  _notify(userKey: string, value: unknown): void {
    for (const cb of this._onReceive) {
      try { cb(userKey, value); } catch {}
    }
    const view = this._createPayloadView();
    for (const cb of this._onUpdate) {
      try { cb(view); } catch {}
    }
  }

  private _createPayloadView(): TopicClientPayloadView {
    return {
      get: (key: string) => this.get(key),
      keys: this.keys,
    };
  }

  get _idx(): number { return this._index; }

  /** @internal — update wire index */
  _setIndex(index: number): void { this._index = index; }
}
