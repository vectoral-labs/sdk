// Salt policy for prompt fingerprinting.
//
// A prompt fingerprint is a one-way digest of normalized prompt text. The salt
// decides WHO can compare two fingerprints:
//
//   secret tenant salt  -> only you. Nobody without the salt can correlate your
//                          fingerprints, including against a dictionary of
//                          guessed prompts.
//   no salt ("global")  -> every Vectoral customer who opted in. Catches a farm
//                          that reuses the same prompts across victims, at the
//                          cost of that comparability.
//
// The salt is a secret and must never reach a browser. The browser-side
// analogue — device fingerprints — is salted with the PUBLISHABLE site key
// instead, which scopes values to your tenant without pretending to be secret.
// See docs/concepts/salts.md.

import { VectoralConfigError } from "./errors.js";

/** Minimum salt length we will accept. 32 hex chars = 128 bits. */
export const MIN_SALT_LENGTH = 32;

export interface FingerprintOptions {
  /**
   * Master switch. When false or absent, prompt text is never read and never
   * hashed — the SDK does not touch it.
   */
  enabled: boolean;
  /**
   * Secret tenant salt. Defaults to `process.env.VECTORAL_FINGERPRINT_SALT`.
   * Treat it like a signing key: 128+ bits, out of source control, rotated
   * deliberately.
   */
  salt?: string;
  /**
   * Generation id for `salt`, e.g. `s_2026_09`. Sent alongside every
   * fingerprint so the server knows which generation a value belongs to and
   * never compares across a rotation. Defaults to
   * `process.env.VECTORAL_FINGERPRINT_SALT_ID`.
   */
  saltId?: string;
  /**
   * Additionally compute an UNSALTED fingerprint, comparable across all
   * Vectoral customers who opted in. Requires `enabled`. Opting in
   * acknowledges the reduced confidentiality of that tier.
   */
  shareGlobal?: boolean;
}

/** Resolved config. `null` means fingerprinting is inert for this client. */
export interface ResolvedFingerprintConfig {
  salt: string;
  saltId: string;
  shareGlobal: boolean;
}

export interface ResolveResult {
  config: ResolvedFingerprintConfig | null;
  /** Non-fatal problems. The caller surfaces these; it never throws on them. */
  warnings: string[];
}

const env = (name: string): string | undefined => {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  return p?.env?.[name];
};

/** Salts that show up in copy-pasted examples and must never reach production. */
const PLACEHOLDER_SALTS = new Set([
  "changeme",
  "your-salt-here",
  "test",
  "secret",
  "vectoral",
]);

/**
 * Resolve fingerprinting config from explicit options and the environment.
 *
 * Fails OPEN by design: a missing or unusable salt disables fingerprinting with
 * a warning rather than throwing. Customer traffic must never block on
 * fingerprint configuration — a score request without a fingerprint is merely
 * less informed, while a constructor that throws in production is an outage.
 *
 * The one exception is `shareGlobal` without `enabled`, which is a
 * contradiction in the caller's intent rather than a missing value, so it
 * throws at construction time.
 */
export function resolveFingerprintConfig(
  opts: FingerprintOptions | undefined,
): ResolveResult {
  const warnings: string[] = [];
  if (!opts?.enabled) {
    if (opts?.shareGlobal) {
      throw new VectoralConfigError(
        "fingerprint.shareGlobal requires fingerprint.enabled: true",
      );
    }
    return { config: null, warnings };
  }

  const salt = opts.salt ?? env("VECTORAL_FINGERPRINT_SALT");
  const saltId = opts.saltId ?? env("VECTORAL_FINGERPRINT_SALT_ID");

  if (!salt || !saltId) {
    warnings.push(
      "fingerprint.enabled is set but salt/saltId are missing (pass them, or set " +
        "VECTORAL_FINGERPRINT_SALT and VECTORAL_FINGERPRINT_SALT_ID) — " +
        "prompt fingerprinting is disabled",
    );
    return { config: null, warnings };
  }
  if (PLACEHOLDER_SALTS.has(salt.toLowerCase())) {
    warnings.push(
      "fingerprint.salt is a well-known placeholder value — prompt fingerprinting " +
        "is disabled. Generate one with generateSalt().",
    );
    return { config: null, warnings };
  }
  if (salt.length < MIN_SALT_LENGTH) {
    warnings.push(
      `fingerprint.salt is only ${salt.length} characters; at least ` +
        `${MIN_SALT_LENGTH} are required for a meaningful search space — ` +
        "prompt fingerprinting is disabled",
    );
    return { config: null, warnings };
  }

  return {
    config: { salt, saltId, shareGlobal: opts.shareGlobal ?? false },
    warnings,
  };
}

/**
 * Generate a fresh tenant salt: 32 random bytes, hex-encoded.
 *
 * For bootstrapping and rotation. Store the output in your secret manager and
 * pair it with a new `saltId`; do not call this at process start, which would
 * mint a new salt per deploy and make every stored fingerprint incomparable.
 */
export function generateSalt(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A conventional salt id for the current month, e.g. `s_2026_09`. Any stable
 * string works; the convention just makes rotations self-documenting in logs.
 */
export function suggestSaltId(now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `s_${yyyy}_${mm}`;
}
