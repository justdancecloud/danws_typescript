export { DataType, FrameType, DanWSError, DLE, STX, ETX, ENQ, DATA_TYPE_SIZES } from "./types.js";
export type { Frame } from "./types.js";
export { serialize, deserialize } from "./serializer.js";
export { dleEncode, dleDecode } from "./dle.js";
export { encode, decode, encodeBatch, encodeHeartbeat } from "./codec.js";
export { createStreamParser } from "./stream-parser.js";
export type { StreamParser } from "./stream-parser.js";
