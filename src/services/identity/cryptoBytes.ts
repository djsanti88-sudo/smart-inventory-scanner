export function realmSafeBytes(value: ArrayBuffer | ArrayBufferView): Uint8Array<ArrayBuffer> {
  if (ArrayBuffer.isView(value)) {
    return Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  return Uint8Array.from(new Uint8Array(value));
}
