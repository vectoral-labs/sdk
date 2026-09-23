import { describe, it, expect } from "vitest";
import { xxh64 } from "./xxhash64.js";
import { hex64, utf8, bytesToBase64 } from "./encoding.js";

describe("xxh64", () => {
  // Reference vectors from the canonical xxHash implementation — the same
  // four the Go suite pins (internal/fingerprint/xxhash_test.go).
  const cases: Array<[string, bigint, bigint]> = [
    ["", 0n, 0xef46db3751d8e999n],
    ["abc", 0n, 0x44bc2cf5ad770999n],
    ["Nobody inspects the spammish repetition", 0n, 0xfbcea83c8a378bf1n],
    ["abc", 1n, 0xbea9ca8199328908n], // pinned from python-xxhash
  ];
  it("matches reference vectors", () => {
    for (const [input, seed, want] of cases) {
      expect(xxh64(utf8(input), seed)).toBe(want);
    }
  });
  it("covers every tail-length path 0..64 without collision", () => {
    const buf = new Uint8Array(64);
    for (let i = 0; i < 64; i++) buf[i] = (i * 7) & 0xff;
    const seen = new Set<bigint>();
    for (let n = 0; n <= 64; n++) {
      const h = xxh64(buf.subarray(0, n), 12345n);
      expect(seen.has(h)).toBe(false);
      seen.add(h);
    }
  });
});

describe("encoding", () => {
  it("hex64 pads and lowercases", () => {
    expect(hex64(0x9f3e8a12c4d90b77n)).toBe("9f3e8a12c4d90b77");
    expect(hex64(1n)).toBe("0000000000000001");
  });
  const refBase64 = (b: Uint8Array): string =>
    btoa(String.fromCharCode(...b));
  it("base64 round-trips 128 bytes", () => {
    const b = new Uint8Array(128).map((_, i) => i);
    expect(bytesToBase64(b)).toBe(refBase64(b));
  });
  it("base64 handles non-multiple-of-3 lengths", () => {
    for (const n of [1, 2, 3, 4, 5]) {
      const b = new Uint8Array(n).map((_, i) => 250 + i);
      expect(bytesToBase64(b)).toBe(refBase64(b));
    }
  });
});
