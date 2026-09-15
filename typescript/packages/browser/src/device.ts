// Device fingerprint — a stable, tenant-scoped identifier for this browser.
//
// SALT POLICY. This runs in the user's browser, so nothing it holds is secret.
// We salt with the PUBLISHABLE site key, which buys scoping rather than
// secrecy: the same device produces different values for different Vectoral
// customers, so a fingerprint leaked from your logs cannot be joined against
// another tenant's. Never put a secret salt here — shipping one to the browser
// only tells you it was a secret. See docs/concepts/salts.md.

import {
  canvasSample,
  hasDom,
  nav,
  safe,
  screenInfo,
  timezone,
  webglInfo,
} from "./env.js";

/** Bumping this deliberately invalidates every previously issued value. */
const FINGERPRINT_VERSION = 1;

export interface DeviceFingerprintOptions {
  /** Your publishable site key (`pk_live_…`). Scopes the value to your tenant. */
  siteKey: string;
}

export interface DeviceFingerprint {
  /** `fp_` + 32 hex chars. Send as `device_fingerprint`. */
  fingerprint: string;
  /**
   * False when SubtleCrypto was unavailable (an insecure context) and a
   * non-cryptographic fallback hash was used. The value is still stable and
   * still comparable — it is just cheaper to reverse, so do not treat it as a
   * privacy boundary.
   */
  strong: boolean;
  /**
   * How many of the components actually resolved, out of the total attempted.
   * A very low count means a hardened or headless browser, which is itself
   * worth forwarding.
   */
  coverage: { present: number; total: number };
  /** The raw components, for debugging. Never send these anywhere. */
  components: Record<string, string | null>;
}

/**
 * Components chosen for STABILITY as much as entropy. Deliberately excluded:
 *
 *   - the full user-agent string and browser version: churns on every update,
 *     which would reset the fingerprint of every legitimate user monthly while
 *     costing an attacker nothing.
 *   - window size and devicePixelRatio: change with zoom and window dragging.
 *   - `navigator.plugins` contents: empty on modern browsers.
 */
function collectComponents(): Record<string, string | null> {
  const n = safe(nav, {});
  const s = screenInfo();
  const gl = webglInfo();
  const canvas = canvasSample();
  // Each component is probed independently: a hardened browser that throws on
  // one property should cost us that component, not the whole fingerprint. The
  // KEY SET must stay fixed regardless, or `coverage.total` would move and two
  // browsers would hash different material for the same device.
  const probe = (fn: () => string | null | undefined): string | null =>
    safe(fn, null) ?? null;

  return {
    platform: probe(() => n.userAgentData?.platform ?? n.platform),
    // Brand NAMES only — versions are dropped so a browser update does not
    // change the fingerprint.
    brands: probe(() =>
      n.userAgentData?.brands
        ?.map((b) => b.brand)
        .filter((b) => !/not.a.brand/i.test(b))
        .sort()
        .join(","),
    ),
    mobile: probe(() =>
      n.userAgentData?.mobile === undefined ? null : String(n.userAgentData.mobile),
    ),
    language: probe(() => n.language),
    languages: probe(() => n.languages?.join(",")),
    timezone: timezone(),
    screen: probe(() => (s.width > 0 ? `${s.width}x${s.height}x${s.colorDepth}` : null)),
    concurrency: probe(() =>
      n.hardwareConcurrency ? String(n.hardwareConcurrency) : null,
    ),
    memory: probe(() => (n.deviceMemory ? String(n.deviceMemory) : null)),
    touch: probe(() =>
      n.maxTouchPoints === undefined ? null : String(n.maxTouchPoints),
    ),
    webglVendor: gl?.vendor ?? null,
    webglRenderer: gl?.renderer ?? null,
    canvas,
  };
}

/**
 * Compute this browser's device fingerprint.
 *
 * Async because canvas and WebGL probing are, and because SubtleCrypto is.
 * Call it once per page and reuse the result; it does not change within a
 * session.
 *
 * Send the `fingerprint` to YOUR backend, which forwards it as
 * `device_fingerprint`. It is the single highest-value optional field on a
 * registration: one device across many signups is the strongest farm signal
 * that exists, and it is invisible to Vectoral without it.
 */
export async function deviceFingerprint(
  opts: DeviceFingerprintOptions,
): Promise<DeviceFingerprint> {
  if (!opts?.siteKey) {
    throw new Error("deviceFingerprint: `siteKey` is required (it is the salt)");
  }
  if (!hasDom()) {
    throw new Error("deviceFingerprint: no DOM — this runs in the browser only");
  }
  const components = collectComponents();
  const entries = Object.entries(components);
  const present = entries.filter(([, v]) => v !== null && v !== "").length;

  const material = [
    `v${FINGERPRINT_VERSION}`,
    opts.siteKey,
    ...entries.map(([k, v]) => `${k}=${v ?? ""}`),
  ].join("|");

  const { digest, strong } = await hashHex(material);
  return {
    fingerprint: `fp_${digest.slice(0, 32)}`,
    strong,
    coverage: { present, total: entries.length },
    components,
  };
}

async function hashHex(input: string): Promise<{ digest: string; strong: boolean }> {
  const subtle = safe(
    () => (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle,
    undefined,
  );
  if (subtle) {
    try {
      const bytes = new TextEncoder().encode(input);
      const buf = await subtle.digest("SHA-256", bytes);
      const hex = Array.from(new Uint8Array(buf), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      return { digest: hex, strong: true };
    } catch {
      // fall through to the non-crypto path
    }
  }
  return { digest: fnv1a128(input), strong: false };
}

/**
 * Fallback for insecure contexts: four FNV-1a passes with different offset
 * bases, concatenated to 32 hex chars. Not cryptographic — it exists so the
 * fingerprint keeps working on `http://` origins, not to resist analysis.
 */
function fnv1a128(input: string): string {
  const PRIME = 16777619;
  const bases = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b];
  return bases
    .map((base) => {
      let h = base >>> 0;
      for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i) & 0xff;
        h = Math.imul(h, PRIME) >>> 0;
        h ^= input.charCodeAt(i) >>> 8;
        h = Math.imul(h, PRIME) >>> 0;
      }
      return h.toString(16).padStart(8, "0");
    })
    .join("");
}
