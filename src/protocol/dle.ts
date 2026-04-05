import { DLE } from "./types.js";

/**
 * DLE-stuff a payload: every 0x10 byte becomes 0x10 0x10.
 */
export function dleEncode(payload: Uint8Array): Uint8Array {
  // Count DLE bytes to determine output size
  let dleCount = 0;
  for (let i = 0; i < payload.length; i++) {
    if (payload[i] === DLE) dleCount++;
  }

  if (dleCount === 0) return payload;

  const out = new Uint8Array(payload.length + dleCount);
  let j = 0;
  for (let i = 0; i < payload.length; i++) {
    out[j++] = payload[i];
    if (payload[i] === DLE) {
      out[j++] = DLE;
    }
  }
  return out;
}

/**
 * DLE-unstuff a payload: 0x10 0x10 becomes 0x10.
 * The input must NOT contain DLE STX or DLE ETX — those should already
 * be stripped by the frame splitter.
 */
export function dleDecode(data: Uint8Array): Uint8Array {
  let dleCount = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === DLE) {
      i++; // skip next byte (must be DLE)
      dleCount++;
    }
  }

  if (dleCount === 0) return data;

  const out = new Uint8Array(data.length - dleCount);
  let j = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === DLE) {
      i++; // skip the doubled DLE, output one
    }
    out[j++] = data[i];
  }
  return out;
}
