import { DataType, FrameType, DanWSError } from "../protocol/types.js";
import type { Frame } from "../protocol/types.js";

export type AuthPhase = "awaiting_identify" | "awaiting_auth" | "authorized" | "rejected";

export interface AuthConfig {
  required: boolean;
  timeout: number; // ms, default 5000
}

export class AuthController {
  private _phase: AuthPhase = "awaiting_identify";
  private _clientUuid: string | null = null;
  private _principal: string | null = null;
  private _token: string | null = null;
  private _timeoutTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private config: AuthConfig = { required: false, timeout: 5000 }) {}

  get phase(): AuthPhase {
    return this._phase;
  }

  get clientUuid(): string | null {
    return this._clientUuid;
  }

  get principal(): string | null {
    return this._principal;
  }

  get token(): string | null {
    return this._token;
  }

  get isAuthorized(): boolean {
    return this._phase === "authorized";
  }

  private _protocolVersion: [number, number] = [0, 0];

  get protocolVersion(): [number, number] { return this._protocolVersion; }

  /**
   * Process IDENTIFY frame. Extracts the 16-byte UUIDv7 + optional 2-byte protocol version.
   * Returns true if IDENTIFY was valid.
   */
  handleIdentify(payload: Uint8Array): boolean {
    if (this._phase !== "awaiting_identify") {
      return false;
    }

    if (payload.length !== 16 && payload.length !== 18) {
      return false;
    }

    // Convert first 16 bytes to UUID string format
    this._clientUuid = bytesToUuid(payload.subarray(0, 16));

    // Extract protocol version if present (bytes 16-17)
    if (payload.length >= 18) {
      this._protocolVersion = [payload[16], payload[17]];
    }

    if (this.config.required) {
      this._phase = "awaiting_auth";
    } else {
      this._phase = "authorized";
    }

    return true;
  }

  /**
   * Process AUTH frame. Extracts the token string.
   * Returns the token for external verification.
   */
  handleAuth(token: string): string | null {
    if (this._phase !== "awaiting_auth") {
      return null;
    }

    this._token = token;
    return token;
  }

  /**
   * Accept authorization. Sets username and returns AUTH_OK frame.
   */
  accept(principal: string): Frame {
    this._principal = principal;
    this._phase = "authorized";
    this.clearTimeout();

    return {
      frameType: FrameType.AuthOk,
      keyId: 0,
      dataType: DataType.Null,
      payload: null,
    };
  }

  /**
   * Reject authorization. Returns AUTH_FAIL frame.
   */
  reject(reason?: string): Frame {
    this._phase = "rejected";
    this.clearTimeout();

    return {
      frameType: FrameType.AuthFail,
      keyId: 0,
      dataType: DataType.String,
      payload: reason ?? "Authorization rejected",
    };
  }

  // ──── Client side ────

  /** Current protocol version: 3.3 → major=3, minor=3. */
  static readonly PROTOCOL_VERSION = [3, 3] as const;

  /**
   * Build IDENTIFY frame from UUID string.
   * Payload: 16-byte UUID + 2-byte protocol version (major, minor).
   */
  static buildIdentifyFrame(uuid: string): Frame {
    const uuidBytes = uuidToBytes(uuid);
    const payload = new Uint8Array(18);
    payload.set(uuidBytes, 0);
    payload[16] = AuthController.PROTOCOL_VERSION[0];
    payload[17] = AuthController.PROTOCOL_VERSION[1];
    return {
      frameType: FrameType.Identify,
      keyId: 0,
      dataType: DataType.Binary,
      payload,
    };
  }

  /**
   * Build AUTH frame from token string.
   */
  static buildAuthFrame(token: string): Frame {
    return {
      frameType: FrameType.Auth,
      keyId: 0,
      dataType: DataType.String,
      payload: token,
    };
  }

  /**
   * Start auth timeout. Calls onTimeout when expired.
   */
  startTimeout(onTimeout: () => void): void {
    this.clearTimeout();
    this._timeoutTimer = setTimeout(() => {
      if (this._phase === "awaiting_auth") {
        onTimeout();
      }
    }, this.config.timeout);
  }

  clearTimeout(): void {
    if (this._timeoutTimer !== null) {
      clearTimeout(this._timeoutTimer);
      this._timeoutTimer = null;
    }
  }

  reset(): void {
    this._phase = "awaiting_identify";
    this._clientUuid = null;
    this._principal = null;
    this._token = null;
    this.clearTimeout();
  }
}

// ──── UUID helpers ────

export function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

export function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32) {
    throw new DanWSError("IDENTIFY_INVALID", "UUID must be 16 bytes");
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
