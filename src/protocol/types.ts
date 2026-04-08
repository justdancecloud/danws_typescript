// Control characters
export const DLE = 0x10;
export const STX = 0x02;
export const ETX = 0x03;
export const ENQ = 0x05;

export enum DataType {
  Null = 0x00,
  Bool = 0x01,
  Uint8 = 0x02,
  Uint16 = 0x03,
  Uint32 = 0x04,
  Uint64 = 0x05,
  Int32 = 0x06,
  Int64 = 0x07,
  Float32 = 0x08,
  Float64 = 0x09,
  String = 0x0a,
  Binary = 0x0b,
  Timestamp = 0x0c,
  VarInteger = 0x0d,
  VarDouble = 0x0e,
  VarFloat = 0x0f,
}

export enum FrameType {
  ServerKeyRegistration = 0x00,
  ServerValue = 0x01,
  ClientKeyRegistration = 0x02,
  ClientValue = 0x03,
  ServerSync = 0x04,
  ClientReady = 0x05,
  ClientSync = 0x06,
  ServerReady = 0x07,
  Error = 0x08,
  ServerReset = 0x09,
  ClientResyncReq = 0x0a,
  ClientReset = 0x0b,
  ServerResyncReq = 0x0c,
  Identify = 0x0d,
  Auth = 0x0e,
  AuthOk = 0x0f,
  AuthFail = 0x11,
  ArrayShiftLeft = 0x20,
  ArrayShiftRight = 0x21,
  ServerKeyDelete = 0x22,
  ClientKeyRequest = 0x23,
  ServerFlushEnd = 0xff,
}

export interface Frame {
  frameType: FrameType;
  keyId: number;
  dataType: DataType;
  payload: unknown;
}

export class DanWSError extends globalThis.Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DanWSError";
  }
}

/** Check if a frame type is a signal (no payload). */
export function isSignalFrame(ft: FrameType): boolean {
  return (
    ft === FrameType.ServerSync ||
    ft === FrameType.ClientReady ||
    ft === FrameType.ClientSync ||
    ft === FrameType.ServerReady ||
    ft === FrameType.ServerReset ||
    ft === FrameType.ClientResyncReq ||
    ft === FrameType.ClientReset ||
    ft === FrameType.ServerResyncReq ||
    ft === FrameType.AuthOk ||
    ft === FrameType.ServerFlushEnd ||
    ft === FrameType.ServerKeyDelete ||
    ft === FrameType.ClientKeyRequest
  );
}

/** Check if a frame type is a key registration. */
export function isKeyRegistrationFrame(ft: FrameType): boolean {
  return ft === FrameType.ServerKeyRegistration || ft === FrameType.ClientKeyRegistration;
}

/** Fixed byte sizes for each data type. -1 means variable length. */
export const DATA_TYPE_SIZES: Record<DataType, number> = {
  [DataType.Null]: 0,
  [DataType.Bool]: 1,
  [DataType.Uint8]: 1,
  [DataType.Uint16]: 2,
  [DataType.Uint32]: 4,
  [DataType.Uint64]: 8,
  [DataType.Int32]: 4,
  [DataType.Int64]: 8,
  [DataType.Float32]: 4,
  [DataType.Float64]: 8,
  [DataType.String]: -1,
  [DataType.Binary]: -1,
  [DataType.Timestamp]: 8,
  [DataType.VarInteger]: -1,
  [DataType.VarDouble]: -1,
  [DataType.VarFloat]: -1,
};
