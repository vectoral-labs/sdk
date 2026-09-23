// Normative normalization pipeline — port of internal/fingerprint/normalize.go.
// Order is binding: NFKC → full lowercase → digit bucketing → whitespace split
// → head-kept cap. Bit-exactness is enforced by the golden-vector test.

/** Cap on fingerprint input: UTF-8 bytes of the space-joined token stream. */
export const MAX_NORMALIZED_BYTES = 32 * 1024;
/** Token floor below which no fingerprint is produced. */
export const MIN_TOKENS = 8;

// Unicode White_Space property, pinned explicitly. JS \s is NOT conformant:
// it matches U+FEFF (BOM, not White_Space) and misses U+0085 (NEL).
const WHITESPACE_RE =
  /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu;

// Each maximal run of ASCII digits becomes a length bucket:
// 1 → "0", 2–3 → "00", ≥4 → "000". ASCII [0-9] only (post-NFKC), pinned.
const bucket = (run: string): string =>
  run.length === 1 ? "0" : run.length <= 3 ? "00" : "000";

/**
 * Run the normative pipeline. collapseDigits=false is used only for the
 * exact-form hash.
 */
export function normalizeTokens(text: string, collapseDigits: boolean): string[] {
  let s = text.normalize("NFKC").toLowerCase();
  if (collapseDigits) s = s.replace(/[0-9]+/g, bucket);
  const tokens = s.split(WHITESPACE_RE).filter((t) => t.length > 0);
  return capTokens(tokens, MAX_NORMALIZED_BYTES);
}

const encoder = new TextEncoder();

// Keep the head of the stream up to maxBytes of UTF-8 counting single
// joining spaces, never splitting a token.
function capTokens(tokens: string[], maxBytes: number): string[] {
  let total = 0;
  for (let i = 0; i < tokens.length; i++) {
    const n = encoder.encode(tokens[i]!).length + (i > 0 ? 1 : 0);
    if (total + n > maxBytes) return tokens.slice(0, i);
    total += n;
  }
  return tokens;
}
