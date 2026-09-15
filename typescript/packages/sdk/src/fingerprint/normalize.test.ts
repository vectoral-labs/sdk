import { describe, it, expect } from "vitest";
import { normalizeTokens, MAX_NORMALIZED_BYTES } from "./normalize.js";

describe("normalizeTokens", () => {
  const cases: Array<{
    name: string;
    input: string;
    collapseDigits: boolean;
    want: string[];
  }> = [
    { name: "basic", input: "Hello   World", collapseDigits: true, want: ["hello", "world"] },
    {
      name: "digit buckets",
      input: "a 7 b 42 c 123 d 4821 e 123456789012",
      collapseDigits: true,
      want: ["a", "0", "b", "00", "c", "00", "d", "000", "e", "000"],
    },
    { name: "digits kept when off", input: "invoice 4821", collapseDigits: false, want: ["invoice", "4821"] },
    { name: "digit run inside token", input: "user_4821x", collapseDigits: true, want: ["user_000x"] },
    // NFKC folds fullwidth digits to ASCII BEFORE bucketing.
    { name: "fullwidth digits", input: "id ４８２１", collapseDigits: true, want: ["id", "000"] },
    // Arabic-Indic digits are NOT ASCII and must NOT collapse (pinned).
    { name: "arabic-indic digits", input: "id ٤٨٢١", collapseDigits: true, want: ["id", "٤٨٢١"] },
    // Full Unicode lowercase: U+0130 → "i" + U+0307.
    { name: "turkish dotted I", input: "İstanbul", collapseDigits: true, want: ["i̇stanbul"] },
    // White_Space property members split — including U+0085 (NEL), which
    // JS \s does NOT match (the pinned class must).
    { name: "nbsp and ls", input: "a\u00a0b\u2028c", collapseDigits: true, want: ["a", "b", "c"] },
    { name: "NEL splits", input: "a\u0085b", collapseDigits: true, want: ["a", "b"] },
    // U+FEFF (BOM) is NOT White_Space — JS \s matches it, our class must not.
    { name: "BOM does not split", input: "aaa\ufeffbbb ccc", collapseDigits: true, want: ["aaa\ufeffbbb", "ccc"] },
    { name: "trim and collapse", input: "  x \t\n y  ", collapseDigits: true, want: ["x", "y"] },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(normalizeTokens(c.input, c.collapseDigits)).toEqual(c.want);
    });
  }

  it("caps at token boundary keeping the head", () => {
    const input = Array(10000).fill("abcd").join(" ");
    const got = normalizeTokens(input, true);
    const joinedLen = got.reduce((n, t, i) => n + t.length + (i > 0 ? 1 : 0), 0);
    expect(joinedLen).toBeLessThanOrEqual(MAX_NORMALIZED_BYTES);
    expect(got[0]).toBe("abcd");
    expect(got[got.length - 1]).toBe("abcd");
    expect(got.length).toBeGreaterThan(6000);
  });
});
