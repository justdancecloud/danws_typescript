import { DLE, STX, ETX, ENQ, DataType, FrameType, DanWSError, isSignalFrame, isKeyRegistrationFrame } from "./types.js";
import type { Frame } from "./types.js";
import { deserialize } from "./serializer.js";

const enum ParserState {
  Idle,
  AfterDLE,       // saw DLE outside of a frame
  InFrame,
  InFrameAfterDLE, // saw DLE inside a frame
}

export interface StreamParser {
  feed(chunk: Uint8Array): void;
  onFrame(callback: (frame: Frame) => void): void;
  onHeartbeat(callback: () => void): void;
  onError(callback: (err: Error) => void): void;
  reset(): void;
}

export function createStreamParser(maxBufferSize = 1_048_576): StreamParser {
  let state: ParserState = ParserState.Idle;
  let buffer: number[] = [];

  const frameCallbacks: Array<(frame: Frame) => void> = [];
  const heartbeatCallbacks: Array<() => void> = [];
  const errorCallbacks: Array<(err: Error) => void> = [];

  function emitFrame(frame: Frame): void {
    for (const cb of frameCallbacks) cb(frame);
  }

  function emitHeartbeat(): void {
    for (const cb of heartbeatCallbacks) cb();
  }

  function emitError(err: Error): void {
    for (const cb of errorCallbacks) cb(err);
  }

  function parseFrame(body: Uint8Array): Frame {
    if (body.length < 6) {
      throw new DanWSError("FRAME_PARSE_ERROR", `Frame body too short: ${body.length} bytes`);
    }

    const frameType = body[0] as FrameType;
    const keyId = ((body[1] << 24) | (body[2] << 16) | (body[3] << 8) | body[4]) >>> 0;
    const dataType = body[5] as DataType;

    // Body is already DLE-decoded by the state machine
    const rawPayload = body.subarray(6);

    let payload: unknown;
    if (isKeyRegistrationFrame(frameType)) {
      payload = new TextDecoder("utf-8", { fatal: true }).decode(rawPayload);
    } else if (isSignalFrame(frameType)) {
      payload = null;
    } else {
      payload = deserialize(dataType, rawPayload);
    }

    return { frameType, keyId, dataType, payload };
  }

  function feed(chunk: Uint8Array): void {
    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i];

      switch (state) {
        case ParserState.Idle:
          if (byte === DLE) {
            state = ParserState.AfterDLE;
          } else {
            emitError(new DanWSError("FRAME_PARSE_ERROR", `Unexpected byte 0x${byte.toString(16).padStart(2, "0")} outside frame`));
          }
          break;

        case ParserState.AfterDLE:
          if (byte === STX) {
            state = ParserState.InFrame;
            buffer = [];
          } else if (byte === ENQ) {
            emitHeartbeat();
            state = ParserState.Idle;
          } else {
            emitError(new DanWSError("INVALID_DLE_SEQUENCE", `Invalid DLE sequence: 0x10 0x${byte.toString(16).padStart(2, "0")}`));
            state = ParserState.Idle;
          }
          break;

        case ParserState.InFrame:
          if (byte === DLE) {
            state = ParserState.InFrameAfterDLE;
          } else {
            if (buffer.length >= maxBufferSize) {
              emitError(new DanWSError("FRAME_TOO_LARGE", `Frame exceeds ${maxBufferSize} bytes`));
              buffer = [];
              state = ParserState.Idle;
            } else {
              buffer.push(byte);
            }
          }
          break;

        case ParserState.InFrameAfterDLE:
          if (byte === ETX) {
            // Frame complete
            try {
              const body = new Uint8Array(buffer);
              const frame = parseFrame(body);
              emitFrame(frame);
            } catch (err) {
              emitError(err instanceof Error ? err : new Error(String(err)));
            }
            buffer = [];
            state = ParserState.Idle;
          } else if (byte === DLE) {
            // Escaped DLE — decode immediately, store single 0x10
            buffer.push(DLE);
            state = ParserState.InFrame;
          } else {
            emitError(new DanWSError("INVALID_DLE_SEQUENCE", `Invalid DLE sequence in frame: 0x10 0x${byte.toString(16).padStart(2, "0")}`));
            buffer = [];
            state = ParserState.Idle;
          }
          break;
      }
    }
  }

  return {
    feed,
    onFrame(callback) {
      frameCallbacks.push(callback);
    },
    onHeartbeat(callback) {
      heartbeatCallbacks.push(callback);
    },
    onError(callback) {
      errorCallbacks.push(callback);
    },
    reset() {
      state = ParserState.Idle;
      buffer = [];
    },
  };
}
