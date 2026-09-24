// POST /v1/registrations/score — screen a signup BEFORE the account exists.

import type { Transport } from "../http.js";
import { VectoralError, notifyError } from "../errors.js";

/** Browser-environment tells, as collected by `@vectoral-labs/browser`. */
export interface RegistrationClientBlock {
  /** `navigator.webdriver`. Cheap, and a strong tell when true. */
  webdriver?: boolean;
  /** Your own [0,1] canvas/WebGL/capability-consistency score. */
  fingerprint_anomaly?: number;
  /** Milliseconds from page load to submit. */
  load_to_submit_ms?: number;
  /** IANA zone, compared against the observed origin. */
  timezone?: string;
}

/** Per-field fill behaviour. `pasted` is the highest-value bit. */
export interface RegistrationFormField {
  pasted?: boolean;
  keystrokes?: number;
  corrections?: number;
  focus_ms?: number;
}

export interface RegistrationFormBlock {
  load_to_submit_ms?: number;
  fields?: Record<string, RegistrationFormField>;
}

/**
 * Body of POST /v1/registrations/score.
 *
 * Every optional field you omit produces an **absent** signal, never a
 * favourable one: no `device_fingerprint` does not mean "no device reuse", and
 * no `form` does not mean "a human typed it".
 */
export interface RegistrationRequest {
  /** The submitted address. The only required field. */
  email: string;
  /**
   * Idempotency key. A repeat of the same `(customer, event_id)` returns the
   * original verdict with `duplicate: true` and writes nothing.
   *
   * Strongly recommended, and the SDK only retries transient failures when it
   * is present. Derive it from your own pending-signup record, not from a
   * transport message id.
   */
  event_id?: string;
  /** The user's browser IP at submit — the one your server observed. */
  ip?: string;
  /** Your own keyed token instead of `ip`. Disables per-subnet velocity. */
  ip_hash?: string;
  asn?: number;
  ip_country?: string;
  /** The country the user claimed, if your form collects one. */
  declared_country?: string;
  user_agent?: string;
  /**
   * Client-side device identifier. **The single highest-value optional field** —
   * one device across many registrations is the strongest farm signal there is.
   * `@vectoral-labs/browser`'s `deviceFingerprint()` produces one.
   */
  device_fingerprint?: string;
  /** A token from the browser sensor, if deployed. */
  sensor_token?: string;
  client?: RegistrationClientBlock;
  form?: RegistrationFormBlock;
  phone?: string;
  username?: string;
  referrer?: string;
  /**
   * Whole-call budget in ms for the server's external lookups. Defaults to 400
   * server-side and is clamped to [250, 2000] rather than rejected. The SDK
   * raises its own HTTP timeout to sit above whatever you set here.
   */
  deadline_ms?: number;
}

/**
 * What to do with the signup. An **open, ordered scale** — higher means more
 * friction. Compare (`tier >= Tier.StepUp`); never switch exhaustively, because
 * new tiers can be added without a new API version.
 */
export const RegistrationTier = {
  Allow: 0,
  Challenge: 1,
  StepUp: 2,
} as const;

export interface RegistrationVerdict {
  /**
   * Opaque handle to pass back on `identity.record()` when the account is
   * created. `null` only when the call failed open — there is nothing to link.
   */
  registration_id: string | null;
  /** See `RegistrationTier`. Compare, do not switch. */
  tier: number;
  /** The underlying risk score in [0,1], for your own tuning. */
  score: number;
  /** Up to three contributing facts, most significant first. Do not branch on these. */
  reasons: string[];
  /** True on an idempotent replay of a previous `event_id`. */
  duplicate?: boolean;
  /** True during the warm-up window, when `tier` is pinned to 0. */
  shadow_mode?: boolean;
  /**
   * True when this verdict is the SDK's fail-open default rather than a real
   * answer — the call errored and `failOpen` was on. Log it: a flow silently
   * running at `tier: 0` because Vectoral is unreachable looks identical to one
   * where every signup is clean.
   */
  degraded: boolean;
  /** The underlying failure, when `degraded`. */
  error?: VectoralError;
}

/** Wire shape, before the SDK adds `degraded`. */
interface RegistrationResponseBody {
  registration_id: string;
  tier: number;
  score: number;
  reasons: string[] | null;
  duplicate?: boolean;
  shadow_mode?: boolean;
}

const DEADLINE_MIN_MS = 250;
const DEADLINE_MAX_MS = 2000;
/** Headroom over the server-side deadline for TLS, queueing, and the response. */
const DEADLINE_OVERHEAD_MS = 300;

export interface RegistrationsOptions {
  failOpen: boolean;
  onError: ((err: VectoralError, context: string) => void) | undefined;
}

export class Registrations {
  constructor(
    private readonly transport: Transport,
    private readonly opts: RegistrationsOptions,
  ) {}

  /**
   * Score a registration at form submit.
   *
   * With `failOpen` (the default) this never throws: any network failure,
   * timeout, or HTTP error yields `tier: 0, degraded: true`. A screening check
   * that can take your signup page down is worse than no screening check.
   */
  async score(req: RegistrationRequest): Promise<RegistrationVerdict> {
    try {
      const body = await this.transport.post<RegistrationResponseBody>(
        "/v1/registrations/score",
        req,
        {
          idempotent: req.event_id !== undefined,
          ...(req.deadline_ms !== undefined
            ? { timeoutMs: httpTimeoutFor(req.deadline_ms) }
            : {}),
        },
      );
      // A 2xx body is not automatically a verdict: a proxy or a version-skewed
      // service can return well-formed JSON with no `tier` at all. Left
      // unchecked, `undefined >= RegistrationTier.StepUp` is false and the call
      // reads as a clean allow with `degraded` unset — the one failure the
      // reliability contract promises is always visible.
      if (typeof body?.tier !== "number" || typeof body?.score !== "number") {
        throw new VectoralError(
          "vectoral: response is not a registration verdict (missing numeric `tier`/`score`)",
          { code: "invalid_response", status: 200, responseBody: JSON.stringify(body) },
        );
      }
      return {
        registration_id: body.registration_id,
        tier: body.tier,
        score: body.score,
        reasons: body.reasons ?? [],
        ...(body.duplicate !== undefined ? { duplicate: body.duplicate } : {}),
        ...(body.shadow_mode !== undefined ? { shadow_mode: body.shadow_mode } : {}),
        degraded: false,
      };
    } catch (err) {
      if (!this.opts.failOpen || !(err instanceof VectoralError)) throw err;
      notifyError(this.opts.onError, err, "registrations.score");
      return {
        registration_id: null,
        tier: RegistrationTier.Allow,
        score: 0,
        reasons: [],
        degraded: true,
        error: err,
      };
    }
  }
}

/**
 * The HTTP timeout must sit ABOVE the server's own deadline, or we abort a
 * request the server was about to answer and turn a usable verdict into a
 * fail-open 0.
 */
export function httpTimeoutFor(deadlineMs: number): number {
  const clamped = Math.min(Math.max(deadlineMs, DEADLINE_MIN_MS), DEADLINE_MAX_MS);
  return clamped + DEADLINE_OVERHEAD_MS;
}
