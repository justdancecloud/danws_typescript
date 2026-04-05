export class StateStore {
  private values = new Map<number, unknown>();

  set(keyId: number, value: unknown): void {
    this.values.set(keyId, value);
  }

  get(keyId: number): unknown {
    return this.values.get(keyId);
  }

  has(keyId: number): boolean {
    return this.values.has(keyId);
  }

  getAll(): Map<number, unknown> {
    return new Map(this.values);
  }

  clear(): void {
    this.values.clear();
  }
}
