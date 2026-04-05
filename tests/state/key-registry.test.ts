import { describe, it, expect } from "vitest";
import { KeyRegistry, validateKeyPath } from "../../src/state/key-registry.js";
import { DataType, DanWSError } from "../../src/protocol/types.js";

describe("validateKeyPath", () => {
  it("accepts valid paths", () => {
    expect(() => validateKeyPath("root.status.alive")).not.toThrow();
    expect(() => validateKeyPath("root.users.0.name")).not.toThrow();
    expect(() => validateKeyPath("sensor.floor_3.temp")).not.toThrow();
    expect(() => validateKeyPath("input.joystick.x")).not.toThrow();
    expect(() => validateKeyPath("single")).not.toThrow();
    expect(() => validateKeyPath("a.b.c.d.e")).not.toThrow();
  });

  it("rejects empty path", () => {
    expect(() => validateKeyPath("")).toThrow(DanWSError);
  });

  it("rejects leading dot", () => {
    expect(() => validateKeyPath(".leading")).toThrow(DanWSError);
  });

  it("rejects trailing dot", () => {
    expect(() => validateKeyPath("trailing.")).toThrow(DanWSError);
  });

  it("rejects consecutive dots", () => {
    expect(() => validateKeyPath("double..dot")).toThrow(DanWSError);
  });

  it("rejects spaces", () => {
    expect(() => validateKeyPath("has space")).toThrow(DanWSError);
  });

  it("rejects path exceeding 200 bytes", () => {
    const long = "a".repeat(201);
    expect(() => validateKeyPath(long)).toThrow(DanWSError);
  });

  it("accepts path exactly 200 bytes", () => {
    const exact = "a".repeat(200);
    expect(() => validateKeyPath(exact)).not.toThrow();
  });
});

describe("KeyRegistry", () => {
  it("registers keys with sequential IDs", () => {
    const reg = new KeyRegistry();
    reg.register([
      { path: "root.alive", type: DataType.Bool },
      { path: "root.name", type: DataType.String },
      { path: "root.temp", type: DataType.Float32 },
    ]);

    expect(reg.size).toBe(3);
    expect(reg.getByKeyId(1)?.path).toBe("root.alive");
    expect(reg.getByKeyId(2)?.path).toBe("root.name");
    expect(reg.getByKeyId(3)?.path).toBe("root.temp");
  });

  it("looks up by path", () => {
    const reg = new KeyRegistry();
    reg.register([
      { path: "sensor.temp", type: DataType.Float32 },
    ]);

    expect(reg.getByPath("sensor.temp")?.keyId).toBe(1);
    expect(reg.getByPath("sensor.temp")?.type).toBe(DataType.Float32);
    expect(reg.getByPath("nonexistent")).toBeUndefined();
  });

  it("has helpers", () => {
    const reg = new KeyRegistry();
    reg.register([{ path: "a", type: DataType.Bool }]);

    expect(reg.hasKeyId(1)).toBe(true);
    expect(reg.hasKeyId(2)).toBe(false);
    expect(reg.hasPath("a")).toBe(true);
    expect(reg.hasPath("b")).toBe(false);
  });

  it("register replaces all existing keys", () => {
    const reg = new KeyRegistry();
    reg.register([
      { path: "old.key", type: DataType.Bool },
    ]);
    expect(reg.size).toBe(1);

    reg.register([
      { path: "new.key1", type: DataType.String },
      { path: "new.key2", type: DataType.Uint32 },
    ]);
    expect(reg.size).toBe(2);
    expect(reg.hasPath("old.key")).toBe(false);
    expect(reg.getByKeyId(1)?.path).toBe("new.key1");
  });

  it("rejects duplicate paths in single register call", () => {
    const reg = new KeyRegistry();
    expect(() =>
      reg.register([
        { path: "dup", type: DataType.Bool },
        { path: "dup", type: DataType.String },
      ]),
    ).toThrow(DanWSError);
  });

  it("clear removes all entries", () => {
    const reg = new KeyRegistry();
    reg.register([{ path: "a", type: DataType.Bool }]);
    reg.clear();
    expect(reg.size).toBe(0);
    expect(reg.hasKeyId(1)).toBe(false);
  });

  it("paths returns registered paths in order", () => {
    const reg = new KeyRegistry();
    reg.register([
      { path: "c.val", type: DataType.Uint8 },
      { path: "a.val", type: DataType.Uint8 },
      { path: "b.val", type: DataType.Uint8 },
    ]);
    expect(reg.paths).toEqual(["c.val", "a.val", "b.val"]);
  });
});
