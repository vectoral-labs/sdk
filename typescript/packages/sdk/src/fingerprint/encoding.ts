// Encoding helpers for the fingerprint wire format. No Buffer dependency —
// the SDK must run in any Node ≥18 (and stay bundler-friendly).

const encoder = new TextEncoder();

/** UTF-8 bytes of a string. */
export const utf8 = (s: string): Uint8Array => encoder.encode(s);

/** 16 lowercase zero-padded hex digits of an unsigned 64-bit bigint. */
export const hex64 = (v: bigint): string => v.toString(16).padStart(16, "0");

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64 (with padding) of raw bytes. */
export function bytesToBase64(b: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 3 <= b.length; i += 3) {
    const n = (b[i]! << 16) | (b[i + 1]! << 8) | b[i + 2]!;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rem = b.length - i;
  if (rem === 1) {
    const n = b[i]! << 16;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + "==";
  } else if (rem === 2) {
    const n = (b[i]! << 16) | (b[i + 1]! << 8);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + "=";
  }
  return out;
}
