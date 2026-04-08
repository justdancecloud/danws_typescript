import { DataType, DanWSError } from "../protocol/types.js";

export interface KeyDefinition {
  path: string;
  type: DataType;
}

interface KeyEntry {
  path: string;
  type: DataType;
  keyId: number;
}

const KEY_PATH_REGEX = /^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)*$/;
const MAX_KEY_PATH_BYTES = 200;

const textEncoder = new TextEncoder();

export function validateKeyPath(path: string): void {
  if (path.length === 0) {
    throw new DanWSError("INVALID_KEY_PATH", "Key path must not be empty");
  }
  if (!KEY_PATH_REGEX.test(path)) {
    throw new DanWSError("INVALID_KEY_PATH", `Invalid key path: "${path}"`);
  }
  if (textEncoder.encode(path).length > MAX_KEY_PATH_BYTES) {
    throw new DanWSError("INVALID_KEY_PATH", `Key path exceeds 200 bytes: "${path}"`);
  }
}

export class KeyRegistry {
  private byId = new Map<number, KeyEntry>();
  private byPath = new Map<string, KeyEntry>();
  private nextId = 1;

  register(keys: KeyDefinition[]): void {
    // Check for duplicates within the input
    const paths = new Set<string>();
    for (const key of keys) {
      validateKeyPath(key.path);
      if (paths.has(key.path)) {
        throw new DanWSError("DUPLICATE_KEY_PATH", `Duplicate key path: "${key.path}"`);
      }
      paths.add(key.path);
    }

    // Clear existing and re-register
    this.clear();
    for (const key of keys) {
      const entry: KeyEntry = { path: key.path, type: key.type, keyId: this.nextId };
      this.byId.set(this.nextId, entry);
      this.byPath.set(key.path, entry);
      this.nextId++;
    }
  }

  /**
   * Register a single key with a specific keyId (used for receiving remote registrations).
   */
  registerOne(keyId: number, path: string, type: DataType): void {
    validateKeyPath(path);
    const entry: KeyEntry = { path, type, keyId };
    this.byId.set(keyId, entry);
    this.byPath.set(path, entry);
    if (keyId >= this.nextId) {
      this.nextId = keyId + 1;
    }
  }

  getByKeyId(keyId: number): KeyEntry | undefined {
    return this.byId.get(keyId);
  }

  getByPath(path: string): KeyEntry | undefined {
    return this.byPath.get(path);
  }

  hasKeyId(keyId: number): boolean {
    return this.byId.has(keyId);
  }

  hasPath(path: string): boolean {
    return this.byPath.has(path);
  }

  removeByKeyId(keyId: number): boolean {
    const entry = this.byId.get(keyId);
    if (!entry) return false;
    this.byId.delete(keyId);
    this.byPath.delete(entry.path);
    return true;
  }

  get size(): number {
    return this.byId.size;
  }

  get paths(): string[] {
    return Array.from(this.byPath.keys());
  }

  entries(): IterableIterator<KeyEntry> {
    return this.byId.values();
  }

  clear(): void {
    this.byId.clear();
    this.byPath.clear();
    this.nextId = 1;
  }
}
