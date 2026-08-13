export interface TruncatedUtf8 {
  content: string;
  truncated: boolean;
}

export function decodeUtf8Prefix(bytes: Uint8Array, maxBytes = bytes.byteLength): TruncatedUtf8 {
  const limited = bytes.subarray(0, maxBytes);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let end = limited.byteLength;
  while (end > 0) {
    try {
      return {
        content: decoder.decode(limited.subarray(0, end)),
        truncated: bytes.byteLength > maxBytes || end < limited.byteLength,
      };
    } catch {
      end -= 1;
    }
  }
  return { content: "", truncated: bytes.byteLength > 0 };
}

export function truncateUtf8(value: string, maxBytes: number): TruncatedUtf8 {
  return decodeUtf8Prefix(Buffer.from(value), maxBytes);
}
