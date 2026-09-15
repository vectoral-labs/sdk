import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  saltSeed,
  shingleSet,
  simHash64,
  minHash64x16,
  signatureBytes,
  bandKeys,
  exactHash,
} from "./similarity.js";
import { xxh64 } from "./xxhash64.js";
import { utf8 } from "./encoding.js";
import localConstants from "./minhash_constants.json";

describe("constants parity", () => {
  it("local copy matches the canonical repo file byte-for-byte semantically", () => {
    // Both files are vendored from the monorepo by
    // scripts/sync-fingerprint-vectors.sh; this guards against one being
    // refreshed without the other.
    const canonicalPath = fileURLToPath(
      new URL("./testdata/canonical_minhash_constants.json", import.meta.url),
    );
    const canonical = JSON.parse(readFileSync(canonicalPath, "utf8"));
    expect(localConstants).toEqual(canonical);
  });
});

describe("similarity primitives", () => {
  it("saltSeed = xxh64(salt, 0)", () => {
    expect(saltSeed("s")).toBe(xxh64(utf8("s"), 0n));
  });

  it("shingle set dedupes", () => {
    const tokens = ["a", "b", "c", "a", "b", "c", "a", "b", "c"];
    expect(shingleSet(tokens, 1n)).toHaveLength(3);
  });

  it("simhash tie resolves to 0", () => {
    expect(simHash64([0xaaaaaaaaaaaaaaaan, 0x5555555555555555n])).toBe(0n);
  });

  it("single-input simhash equals the input", () => {
    expect(simHash64([0xdeadbeef12345678n])).toBe(0xdeadbeef12345678n);
  });

  it("signature bytes are little-endian", () => {
    const sig = new Uint16Array(64);
    sig[0] = 0x1234;
    const b = signatureBytes(sig);
    expect(b.length).toBe(128);
    expect(b[0]).toBe(0x34);
    expect(b[1]).toBe(0x12);
  });

  it("band keys depend on seed and exactly their rows", () => {
    const sig = new Uint16Array(64).map((_, i) => (i * 251) & 0xffff);
    const k1 = bandKeys(sig, 1n);
    const k2 = bandKeys(sig, 2n);
    expect(k1).not.toEqual(k2);
    const sig2 = Uint16Array.from(sig);
    sig2[12]! += 1; // row 12 lives in band 3
    const k3 = bandKeys(sig2, 1n);
    for (let band = 0; band < 16; band++) {
      if (band === 3) expect(k1[band]).not.toBe(k3[band]);
      else expect(k1[band]).toBe(k3[band]);
    }
  });

  it("exact hash differs across digit values, stable under whitespace", () => {
    const a = exactHash("transfer 500 to account 4821 now please ok", 7n);
    const b = exactHash("transfer 900 to account 1111 now please ok", 7n);
    const c = exactHash("transfer  500 to account\t4821 now please ok", 7n);
    expect(a).not.toBe(b);
    expect(a).toBe(c);
  });
});
