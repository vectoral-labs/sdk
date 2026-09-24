import { VectoralConfigError, VectoralError } from "./errors.js";
import { Transport, type FetchLike } from "./http.js";
import { resolveFingerprintConfig, type FingerprintOptions } from "./salt.js";
import { Registrations } from "./resources/registrations.js";
import { Inference } from "./resources/inference.js";
import { Identity } from "./resources/identity.js";
import { Labels } from "./resources/labels.js";

const DEFAULT_BASE_URL = "https://api.vectoral.cloud";
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRIES = 2;

export interface VectoralOptions {
  /**
   * API key (`vg_live_…`), sent as `Authorization: Bearer`. Defaults to
   * `process.env.VECTORAL_API_KEY`. Provide exactly one of `apiKey` or
   * `customerId`.
   */
  apiKey?: string;
  /**
   * Customer identifier, sent as `X-Customer-ID`. Only for a self-hosted or
   * in-VPC deployment running in header auth mode.
   */
  customerId?: string;
  /** API base URL. Defaults to `VECTORAL_BASE_URL`, then the hosted endpoint. */
  baseUrl?: string;
  /** Per-request timeout in ms. Default 5000. */
  timeoutMs?: number;
  /** Custom fetch implementation. Defaults to global fetch. */
  fetch?: FetchLike;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
  /**
   * Retry attempts for transient failures. Default 2.
   *
   * **Only applied to calls that carry an `event_id`.** Every write endpoint
   * mints a new row per call, so retrying a request without an idempotency key
   * would double-write after a response lost in transit. Supplying `event_id`
   * is what buys you retries.
   */
  retries?: number;
  /**
   * Return a safe default instead of throwing when a scoring call fails.
   * Default true. Applies to `registrations.score()` and `inference.score()`;
   * results carry `degraded: true`. Telemetry and label calls always throw —
   * you want to know when those are being dropped.
   */
  failOpen?: boolean;
  /** Privacy-preserving prompt fingerprinting. Off unless `enabled`. */
  fingerprint?: FingerprintOptions;
  /** Called for every fail-open failure. Default: none (silent). Wire this up. */
  onError?: (err: VectoralError, context: string) => void;
  /** Called for non-fatal configuration problems. Defaults to `console.warn`. */
  onWarning?: (message: string) => void;
}

const env = (name: string): string | undefined => {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  return p?.env?.[name];
};

/**
 * Server-side Vectoral client.
 *
 * Use this on your backend only. It holds a secret API key, and the signals it
 * sends — above all the client IP — are only trustworthy when your own server
 * observed them.
 */
export class Vectoral {
  readonly registrations: Registrations;
  readonly inference: Inference;
  readonly identity: Identity;
  readonly labels: Labels;
  /** True when prompt fingerprinting resolved to a usable salt. */
  readonly fingerprintingActive: boolean;

  constructor(opts: VectoralOptions = {}) {
    const customerId = opts.customerId;
    // The env fallback applies only when no credential was passed at all. A
    // stray VECTORAL_API_KEY in a shared .env or on a CI runner must not make
    // header auth unconstructable — the caller supplied exactly one credential.
    const apiKey = opts.apiKey ?? (customerId ? undefined : env("VECTORAL_API_KEY"));
    if (apiKey && customerId) {
      throw new VectoralConfigError(
        "provide either `apiKey` or `customerId`, not both",
      );
    }
    let authHeader: Record<string, string>;
    if (apiKey) {
      authHeader = { Authorization: `Bearer ${apiKey}` };
    } else if (customerId) {
      authHeader = { "X-Customer-ID": customerId };
    } else {
      throw new VectoralConfigError(
        "`apiKey` is required (pass it, or set VECTORAL_API_KEY)",
      );
    }

    const fetchImpl = opts.fetch ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new VectoralConfigError(
        "no global fetch available — pass `fetch` (Node >=20 has it built in)",
      );
    }

    const onWarning =
      opts.onWarning ?? ((m: string) => console.warn(`[vectoral] ${m}`));
    const resolved = resolveFingerprintConfig(opts.fingerprint);
    for (const w of resolved.warnings) onWarning(w);
    this.fingerprintingActive = resolved.config !== null;

    const transport = new Transport({
      baseUrl: (opts.baseUrl ?? env("VECTORAL_BASE_URL") ?? DEFAULT_BASE_URL).replace(
        /\/+$/,
        "",
      ),
      authHeader,
      headers: opts.headers ?? {},
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      fetch: fetchImpl,
      retries: opts.retries ?? DEFAULT_RETRIES,
    });

    const failOpen = opts.failOpen ?? true;
    this.registrations = new Registrations(transport, {
      failOpen,
      onError: opts.onError,
    });
    this.inference = new Inference(transport, {
      failOpen,
      fingerprint: resolved.config,
      onError: opts.onError,
      onWarning,
    });
    this.identity = new Identity(transport);
    this.labels = new Labels(transport);
  }
}

/** Convenience factory equivalent to `new Vectoral(opts)`. */
export const createClient = (opts: VectoralOptions = {}): Vectoral =>
  new Vectoral(opts);
