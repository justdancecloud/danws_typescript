import { DLE, STX, ETX, ENQ, DataType, FrameType, DanWSError } from "./types.js";
import type { Frame } from "./types.js";
import { serialize, deserialize } from "./serializer.js";
import { dleEncode, dleDecode } from "./dle.js";

/**
 * Encode a single Frame into bytes with DLE STX/ETX framing and DLE escaping.
 */
export function encode(frame: Frame): Uint8Array {
  // Serialize payload based on frame type
  let rawPayload: Uint8Array;

  if (isKeyRegistrationFrame(frame.frameType)) {
    // Key registration: payload is UTF-8 keyPath string
    rawPayload = new TextEncoder().encode(frame.payload as string);
  } else if (isSignalFrame(frame.frameType)) {
    // Signal frames: no payload
    rawPayload = new Uint8Array(0);
  } else {
    // Data/auth frames: typed value
    rawPayload = serialize(frame.dataType, frame.payload);
  }

  // Build raw body: [FrameType:1] [KeyID:2] [DataType:1] [Payload:N]
  const rawBody = new Uint8Array(4 + rawPayload.length);
  rawBody[0] = frame.frameType;
  rawBody[1] = (frame.keyId >> 8) & 0xff;
  rawBody[2] = frame.keyId & 0xff;
  rawBody[3] = frame.dataType;
  rawBody.set(rawPayload, 4);

  // DLE-escape the entire body (header + payload)
  const escapedBody = dleEncode(rawBody);

  // Wrap with DLE STX ... DLE ETX
  const result = new Uint8Array(2 + escapedBody.length + 2);
  result[0] = DLE;
  result[1] = STX;
  result.set(escapedBody, 2);
  result[2 + escapedBody.length] = DLE;
  result[3 + escapedBody.length] = ETX;

  return result;
}

/**
 * Encode multiple frames and concatenate into a single buffer.
 */
export function encodeBatch(frames: Frame[]): Uint8Array {
  const encoded = frames.map(encode);
  const totalLength = encoded.reduce((sum, buf) => sum + buf.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const buf of encoded) {
    result.set(buf, offset);
    offset += buf.length;
  }
  return result;
}

/**
 * Encode heartbeat: DLE ENQ (2 bytes).
 */
export function encodeHeartbeat(): Uint8Array {
  return new Uint8Array([DLE, ENQ]);
}

/**
 * Decode a byte buffer containing one or more frames.
 * Returns an array of decoded Frames.
 */
export function decode(bytes: Uint8Array): Frame[] {
  const frames: Frame[] = [];
  let i = 0;

  while (i < bytes.length) {
    // Expect DLE STX
    if (i + 1 >= bytes.length) {
      throw new DanWSError("FRAME_PARSE_ERROR", "Unexpected end of data");
    }
    if (bytes[i] !== DLE || bytes[i + 1] !== STX) {
      throw new DanWSError("FRAME_PARSE_ERROR", `Expected DLE STX at offset ${i}, got 0x${bytes[i].toString(16).padStart(2, "0")} 0x${bytes[i + 1].toString(16).padStart(2, "0")}`);
    }
    i += 2; // skip DLE STX

    // Find DLE ETX (accounting for DLE escaping)
    const bodyStart = i;
    let bodyEnd = -1;

    while (i < bytes.length) {
      if (bytes[i] === DLE) {
        if (i + 1 >= bytes.length) {
          throw new DanWSError("FRAME_PARSE_ERROR", "Unexpected end of data after DLE");
        }
        if (bytes[i + 1] === ETX) {
          bodyEnd = i;
          i += 2; // skip DLE ETX
          break;
        } else if (bytes[i + 1] === DLE) {
          i += 2; // escaped DLE, skip both
        } else {
          throw new DanWSError("INVALID_DLE_SEQUENCE", `Invalid DLE sequence: 0x10 0x${bytes[i + 1].toString(16).padStart(2, "0")}`);
        }
      } else {
        i++;
      }
    }

    if (bodyEnd === -1) {
      throw new DanWSError("FRAME_PARSE_ERROR", "Missing DLE ETX terminator");
    }

    // Body is everything between DLE STX and DLE ETX (still DLE-escaped)
    // DLE-decode the entire body first (header + payload), matching encode() which escapes the entire body
    const decoded = dleDecode(bytes.subarray(bodyStart, bodyEnd));

    if (decoded.length < 4) {
      throw new DanWSError("FRAME_PARSE_ERROR", `Frame body too short: ${decoded.length} bytes (minimum 4)`);
    }

    const frameType = decoded[0] as FrameType;
    const keyId = (decoded[1] << 8) | decoded[2];
    const dataType = decoded[3] as DataType;

    const rawPayload = decoded.subarray(4);

    // Deserialize payload
    let payload: unknown;
    if (isKeyRegistrationFrame(frameType)) {
      payload = new TextDecoder("utf-8", { fatal: true }).decode(rawPayload);
    } else if (isSignalFrame(frameType)) {
      payload = null;
    } else {
      payload = deserialize(dataType, rawPayload);
    }

    frames.push({ frameType, keyId, dataType, payload });
  }

  return frames;
}

function isKeyRegistrationFrame(ft: FrameType): boolean {
  return ft === FrameType.ServerKeyRegistration || ft === FrameType.ClientKeyRegistration;
}


function isSignalFrame(ft: FrameType): boolean {
  return (
    ft === FrameType.ServerSync ||
    ft === FrameType.ClientReady ||
    ft === FrameType.ClientSync ||
    ft === FrameType.ServerReady ||
    ft === FrameType.ServerReset ||
    ft === FrameType.ClientResyncReq ||
    ft === FrameType.ClientReset ||
    ft === FrameType.ServerResyncReq ||
    ft === FrameType.AuthOk
  );
}
