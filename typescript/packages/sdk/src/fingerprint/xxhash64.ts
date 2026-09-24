// Seeded xxHash64 in BigInt — a direct port of the normative Go
// implementation. Bit-exactness with Go and
// Python is enforced by the golden-vector test; any change here that alters
// output is a breaking algo_version bump.

const MASK64 = (1n << 64n) - 1n;

const PRIME64_1 = 0x9e3779b185ebca87n;
const PRIME64_2 = 0xc2b2ae3d27d4eb4fn;
const PRIME64_3 = 0x165667b19e3779f9n;
const PRIME64_4 = 0x85ebca77c2b2ae63n;
const PRIME64_5 = 0x27d4eb2f165667c5n;

const rotl = (v: bigint, r: bigint): bigint =>
  ((v << r) | (v >> (64n - r))) & MASK64;

const round = (acc: bigint, input: bigint): bigint =>
  (rotl((acc + input * PRIME64_2) & MASK64, 31n) * PRIME64_1) & MASK64;

const mergeRound = (acc: bigint, val: bigint): bigint =>
  ((acc ^ round(0n, val)) * PRIME64_1 + PRIME64_4) & MASK64;

const le64 = (b: Uint8Array, i: number): bigint =>
  BigInt(b[i]!) |
  (BigInt(b[i + 1]!) << 8n) |
  (BigInt(b[i + 2]!) << 16n) |
  (BigInt(b[i + 3]!) << 24n) |
  (BigInt(b[i + 4]!) << 32n) |
  (BigInt(b[i + 5]!) << 40n) |
  (BigInt(b[i + 6]!) << 48n) |
  (BigInt(b[i + 7]!) << 56n);

const le32 = (b: Uint8Array, i: number): bigint =>
  BigInt(b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)) |
  (BigInt(b[i + 3]!) << 24n);

/** Seeded xxHash64. Returns the unsigned 64-bit value as a bigint. */
export function xxh64(data: Uint8Array, seed: bigint): bigint {
  const n = data.length;
  let i = 0;
  let h: bigint;
  if (n >= 32) {
    let v1 = (seed + PRIME64_1 + PRIME64_2) & MASK64;
    let v2 = (seed + PRIME64_2) & MASK64;
    let v3 = seed & MASK64;
    let v4 = (seed - PRIME64_1) & MASK64;
    for (; i + 32 <= n; i += 32) {
      v1 = round(v1, le64(data, i));
      v2 = round(v2, le64(data, i + 8));
      v3 = round(v3, le64(data, i + 16));
      v4 = round(v4, le64(data, i + 24));
    }
    h = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & MASK64;
    h = mergeRound(h, v1);
    h = mergeRound(h, v2);
    h = mergeRound(h, v3);
    h = mergeRound(h, v4);
  } else {
    h = (seed + PRIME64_5) & MASK64;
  }
  h = (h + BigInt(n)) & MASK64;
  for (; i + 8 <= n; i += 8) {
    h = (rotl(h ^ round(0n, le64(data, i)), 27n) * PRIME64_1 + PRIME64_4) & MASK64;
  }
  if (i + 4 <= n) {
    h = (rotl(h ^ ((le32(data, i) * PRIME64_1) & MASK64), 23n) * PRIME64_2 + PRIME64_3) & MASK64;
    i += 4;
  }
  for (; i < n; i++) {
    h = (rotl(h ^ ((BigInt(data[i]!) * PRIME64_5) & MASK64), 11n) * PRIME64_1) & MASK64;
  }
  h ^= h >> 33n;
  h = (h * PRIME64_2) & MASK64;
  h ^= h >> 29n;
  h = (h * PRIME64_3) & MASK64;
  h ^= h >> 32n;
  return h;
}
