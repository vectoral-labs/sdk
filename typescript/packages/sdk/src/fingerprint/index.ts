// Public fingerprint API — port of internal/fingerprint/fingerprint.go
// (Compute + ConversationKey). Output fields are already in wire encoding
// (hex / base64 / decimal strings) so the client attaches them directly.

import { hex64, utf8, bytesToBase64 } from "./encoding.js";
import { xxh64 } from "./xxhash64.js";
import { normalizeTokens, MIN_TOKENS } from "./normalize.js";
import {
  saltSeed,
  GLOBAL_SEED,
  shingleSet,
  simHash64,
  minHash64x16,
  signatureBytes,
  bandKeys,
  exactHash,
} from "./similarity.js";

export interface FingerprintOptions {
  /** Also compute the MinHash signature + band keys. */
  minHash: boolean;
  /** Also compute the unsalted global SimHash (cross-customer opt-in). */
  global: boolean;
}

export interface ComputedFingerprint {
  /** True when the prompt is under the 8-token floor; no other field is set. */
  tooShort: boolean;
  simhash?: string; // 16 hex digits
  exactHash?: string; // 16 hex digits
  minhashB64?: string; // base64 of 128 bytes
  bandKeys?: string[]; // 16 decimal signed int64 strings
  simhashGlobal?: string; // 16 hex digits
}

/** Run the full normative pipeline over text with the tenant salt. */
export function computeFingerprint(
  text: string,
  salt: string,
  opts: FingerprintOptions,
): ComputedFingerprint {
  const seed = saltSeed(salt);
  const tokens = normalizeTokens(text, true);
  if (tokens.length < MIN_TOKENS) return { tooShort: true };
  const hashes = shingleSet(tokens, seed);
  const fp: ComputedFingerprint = {
    tooShort: false,
    simhash: hex64(simHash64(hashes)),
    exactHash: hex64(exactHash(text, seed)),
  };
  if (opts.minHash) {
    const sig = minHash64x16(hashes);
    fp.minhashB64 = bytesToBase64(signatureBytes(sig));
    fp.bandKeys = bandKeys(sig, seed).map((k) => k.toString(10));
  }
  if (opts.global) {
    fp.simhashGlobal = hex64(simHash64(shingleSet(tokens, GLOBAL_SEED)));
  }
  return fp;
}

/**
 * Fallback conversation key derived from the first user message:
 * "c_" + hex64(XXH64(normalized text, tenant seed)).
 */
export function conversationKey(firstUserMessage: string, salt: string): string {
  const tokens = normalizeTokens(firstUserMessage, true);
  return "c_" + hex64(xxh64(utf8(tokens.join(" ")), saltSeed(salt)));
}
