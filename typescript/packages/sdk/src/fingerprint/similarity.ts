// SimHash / MinHash / band-key primitives — port of the normative Go
// implementation (internal/fingerprint/{shingle,simhash,minhash}.go).
// The permutation constants are the canonical minhash_constants.json; a
// parity test guards against drift from the repo-root copy.

import { xxh64 } from "./xxhash64.js";
import { utf8 } from "./encoding.js";
import { normalizeTokens } from "./normalize.js";
import constants from "./minhash_constants.json";

/** Tenant hash seed: XXH64(UTF-8(salt), 0). Normative. */
export const saltSeed = (salt: string): bigint => xxh64(utf8(salt), 0n);

/** Seed for the unsalted global fingerprint. Normative. */
export const GLOBAL_SEED = 0n;

const P61 = (1n << 61n) - 1n;

const A: readonly bigint[] = (constants.a as string[]).map(BigInt);
const B: readonly bigint[] = (constants.b as string[]).map(BigInt);
if (A.length !== 64 || B.length !== 64) {
  throw new Error("fingerprint: minhash_constants.json must have 64 a and 64 b values");
}

/**
 * Deduplicated word 3-gram shingle hashes in first-occurrence order.
 * Callers gate on MIN_TOKENS first; <3 tokens yields an empty set.
 */
export function shingleSet(tokens: string[], seed: bigint): bigint[] {
  const seen = new Set<string>();
  const hashes: bigint[] = [];
  for (let i = 0; i + 3 <= tokens.length; i++) {
    const sh = `${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`;
    if (seen.has(sh)) continue;
    seen.add(sh);
    hashes.push(xxh64(utf8(sh), seed));
  }
  return hashes;
}

/**
 * 64-bit SimHash. Normative tie rule: bit i = 1 iff the +1/−1 column sum is
 * strictly positive. Bit tests run in Number space (two 32-bit halves) —
 * 64 BigInt ops per shingle would dominate the runtime.
 */
export function simHash64(hashes: bigint[]): bigint {
  const sums = new Int32Array(64);
  for (const h of hashes) {
    const lo = Number(h & 0xffffffffn);
    const hi = Number(h >> 32n);
    for (let i = 0; i < 32; i++) {
      sums[i]! += (lo >>> i) & 1 ? 1 : -1;
      sums[i + 32]! += (hi >>> i) & 1 ? 1 : -1;
    }
  }
  let out = 0n;
  for (let i = 0; i < 64; i++) {
    if (sums[i]! > 0) out |= 1n << BigInt(i);
  }
  return out;
}

// ((a·h' + b) mod p), h' = h mod p — BigInt is exact by construction, which
// is the whole point (a uint64-wrapping implementation silently produces
// incompatible signatures; forbidden by the spec).
const permute = (a: bigint, b: bigint, hp: bigint): bigint => (a * hp + b) % P61;

/** 64-permutation MinHash signature: min over full values, low 16 bits. */
export function minHash64x16(hashes: bigint[]): Uint16Array {
  const sig = new Uint16Array(64);
  const reduced = hashes.map((h) => h % P61);
  for (let i = 0; i < 64; i++) {
    let min = P61;
    const a = A[i]!;
    const b = B[i]!;
    for (const hp of reduced) {
      const v = permute(a, b, hp);
      if (v < min) min = v;
    }
    sig[i] = Number(min & 0xffffn);
  }
  return sig;
}

/** 128 bytes: 64 rows, each little-endian uint16. Storage/wire form. */
export function signatureBytes(sig: Uint16Array): Uint8Array {
  const out = new Uint8Array(128);
  for (let i = 0; i < 64; i++) {
    out[2 * i] = sig[i]! & 0xff;
    out[2 * i + 1] = sig[i]! >> 8;
  }
  return out;
}

/**
 * 16 LSH band keys: band b = rows 4b..4b+3 (8 bytes LE) hashed with the
 * tenant seed, reinterpreted as signed int64 (BIGINT[] storage form).
 */
export function bandKeys(sig: Uint16Array, seed: bigint): bigint[] {
  const keys: bigint[] = [];
  const buf = new Uint8Array(8);
  for (let band = 0; band < 16; band++) {
    for (let r = 0; r < 4; r++) {
      const v = sig[band * 4 + r]!;
      buf[2 * r] = v & 0xff;
      buf[2 * r + 1] = v >> 8;
    }
    keys.push(BigInt.asIntN(64, xxh64(buf, seed)));
  }
  return keys;
}

/**
 * Exact-form hash: normalized text with digit collapse SKIPPED — separates
 * verbatim repetition from template reuse.
 */
export function exactHash(text: string, seed: bigint): bigint {
  return xxh64(utf8(normalizeTokens(text, false).join(" ")), seed);
}
