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
  private _username: string | null = null;
  private _token: string | null = null;
  private _timeoutTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private config: AuthConfig = { required: false, timeout: 5000 }) {}

  get phase(): AuthPhase {
    return this._phase;
  }

  get clientUuid(): string | null {
    return this._clientUuid;
  }

  get username(): string | null {
    return this._username;
  }

  get token(): string | null {
    return this._token;
  }

  get isAuthorized(): boolean {
    return this._phase === "authorized";
  }

  /**
   * Process IDENTIFY frame. Extracts the 16-byte UUIDv7.
   * Returns true if IDENTIFY was valid.
   */
  handleIdentify(payload: Uint8Array): boolean {
    if (this._phase !== "awaiting_identify") {
      return false;
    }

    if (payload.length !== 16) {
      return false;
    }

    // Convert 16 bytes to UUID string format
    this._clientUuid = bytesToUuid(payload);

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
  accept(username: string): Frame {
    this._username = username;
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

  /**
   * Build IDENTIFY frame from UUID string.
   */
  static buildIdentifyFrame(uuid: string): Frame {
    return {
      frameType: FrameType.Identify,
      keyId: 0,
      dataType: DataType.Binary,
      payload: uuidToBytes(uuid),
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
    this._username = null;
    this._token = null;
    this.clearTimeout();
  }
}

// ──── UUID helpers ────

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function uuidToBytes(uuid: string): Uint8Array {
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
