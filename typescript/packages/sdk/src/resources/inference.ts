// POST /v1/score and POST /v1/events/post-call — the per-inference pair.

import type { Transport } from "../http.js";
import { VectoralError, notifyError } from "../errors.js";
import { assertAck } from "../http.js";
import type { ResolvedFingerprintConfig } from "../salt.js";
import { computeFingerprint, conversationKey } from "../fingerprint/index.js";

/** Risk banding returned alongside the numeric score. */
export type Tier = "low" | "medium" | "high";

/**
 * Reason codes that can appear in a score response. The server returns at most
 * three, ordered by contribution. The `(string & {})` member keeps this a
 * closed union for autocomplete while still accepting codes added server-side
 * after this SDK was published.
 */
export type ReasonCode =
  // cost & consumption
  | "token_velocity_inhuman_burst"
  | "token_velocity_sustained_1h"
  | "robotic_timing"
  | "instant_first_ai_call"
  | "content_generation_ratio"
  | "always_on_pattern"
  | "no_user_interaction"
  // network
  | "datacenter_ip"
  | "ip_rotation"
  | "sybil_ip_cluster"
  // behavior
  | "tight_gap_distribution"
  | "fragmented_sessions"
  | "seven_day_activity"
  // catch-all
  | "insufficient_data"
  | "no_significant_signals"
  | "model_prediction"
  | "shadow_mode"
  | (string & {});

/** Account-context block. All fields optional but recommended. */
export interface AccountBlock {
  /** RFC 3339 timestamp of when the account first existed in your system. */
  first_seen?: string;
  /** Free-form tier label, e.g. "free" | "pro" | "enterprise". */
  subscription_tier?: string;
}

/**
 * Per-session behavioral signals.
 *
 * Semantics matter: OMITTING this block entirely differs from sending it with
 * zero values. If absent, session-derived signals are skipped. If present (even
 * as `{}`), they participate — and `interaction_events_count: 0` is a
 * meaningful "scripted-shaped" signal.
 */
export interface SessionSignals {
  ms_since_last_request?: number;
  ms_since_page_load?: number;
  interaction_events_count?: number;
  is_first_request_in_session?: boolean;
  ms_since_signup?: number;
}

/**
 * Wire form of the prompt fingerprint. 64-bit values are strings (hex for
 * hashes, decimal for band keys) because JSON cannot carry 64-bit integers
 * safely through every runtime.
 */
export interface PromptFingerprintBlock {
  v: 1;
  salt_id: string;
  simhash: string;
  exact_hash: string;
  conversation_key?: string;
  minhash?: string;
  band_keys?: string[];
  simhash_global?: string;
}

/** Per-request context. */
export interface RequestBlock {
  /**
   * End-user IP. Drives datacenter / IP-rotation / sybil signals. Use the IP
   * your SERVER observed, not one reported by the browser.
   */
  ip?: string;
  ip_hash?: string;
  user_agent?: string;
  /** The model you're about to invoke, e.g. "claude-opus-5". */
  model_requested?: string;
  estimated_prompt_tokens?: number;
  /** Pass `null` or omit to skip session signals entirely. */
  session_signals?: SessionSignals | null;
  /** Only used by Deep Mode. Never leaves the customer VPC. */
  prompt_text?: string;
  /** Customer-precomputed embedding (alternative to `prompt_text`). */
  prompt_embedding?: number[];
  /**
   * LOCAL-ONLY input for prompt fingerprinting. When fingerprinting is
   * configured, the SDK hashes this in-process and attaches
   * `prompt_fingerprint`. **This field is always stripped before the request
   * leaves the process** — enabled or not — and is independent of
   * `prompt_text`/Deep Mode.
   */
  prompt_text_to_fingerprint?: string;
  /** Normally set by the SDK; pass it yourself only if you precompute. */
  prompt_fingerprint?: PromptFingerprintBlock;
}

/** Body of POST /v1/score. */
export interface ScoreRequest {
  /** Stable end-user identifier; the primary join key for scoring history. */
  account_id: string;
  /** Your own session token; stored for forensic correlation. */
  session_id?: string;
  account?: AccountBlock;
  request: RequestBlock;
}

export interface ScoreResponse {
  /** Calibrated [0,1] score. 0 = clean, 1 = certain fraud. */
  score: number;
  /** low (<0.4) | medium (<0.7) | high (>=0.7). */
  tier: Tier;
  /** Up to 3 reason codes. */
  reasons: ReasonCode[];
  deep_mode_active: boolean;
  /**
   * False while the per-account baseline is still forming: the score is
   * provisional — advisory, not enforcement-grade.
   */
  baseline_ready: boolean;
  /** True during the customer's warm-up window. The score is still real. */
  shadow_mode: boolean;
  /** Diagnostic only; treat as an opaque string. */
  algorithm?: string;
  algorithm_version?: string;
  /** The Vectoral release that answered, e.g. `0.1.7`. */
  service_version?: string;
  /**
   * True when this is the SDK's fail-open default rather than a real verdict.
   * See `RegistrationVerdict.degraded`.
   */
  degraded?: boolean;
  /** The underlying failure, when `degraded`. */
  error?: VectoralError;
}

/** Body of POST /v1/events/post-call. */
export interface PostCallEvent {
  /** Must match the `account_id` from the preceding score call. */
  account_id: string;
  session_id?: string;
  /** Recommended; omitting it loses model-mix features. */
  model?: string;
  /** Required if `inference_cost_usd` is not supplied. */
  prompt_tokens?: number;
  /** Required if `inference_cost_usd` is not supplied. */
  completion_tokens?: number;
  latency_ms?: number;
  /** If omitted, the server computes cost from its bundled rate table. */
  inference_cost_usd?: number;
  /** Idempotency key. Also what makes an SDK-level retry safe. */
  event_id?: string;
}

export interface OkResponse {
  ok: boolean;
  duplicate?: boolean;
}

export interface InferenceOptions {
  failOpen: boolean;
  fingerprint: ResolvedFingerprintConfig | null;
  onError: ((err: VectoralError, context: string) => void) | undefined;
  onWarning: ((message: string) => void) | undefined;
}

/** The verdict returned when a score call fails open. */
const FAIL_OPEN_SCORE: Omit<ScoreResponse, "error"> = {
  score: 0,
  tier: "low",
  reasons: [],
  deep_mode_active: false,
  baseline_ready: false,
  shadow_mode: false,
  degraded: true,
};

export class Inference {
  private warnedMissingFingerprintInput = false;

  constructor(
    private readonly transport: Transport,
    private readonly opts: InferenceOptions,
  ) {}

  /** Pre-call risk score. Call before invoking the LLM. */
  async score(req: ScoreRequest): Promise<ScoreResponse> {
    try {
      const body = await this.transport.post<ScoreResponse>(
        "/v1/score",
        this.prepare(req),
        { idempotent: false },
      );
      // See the matching check in registrations.score(): syntactically valid
      // JSON is not proof of a verdict, and a silent pass-through would hand
      // the caller a score of `undefined` with `degraded` unset.
      //
      // Every field below is unconditional server-side, and callers branch on
      // all of them — the documented enforcement guard reads `baseline_ready`,
      // so a response missing it would read as "not enforcement-grade" and
      // permit the request while claiming to be healthy.
      //
      // `tier` is checked for being a non-empty string and NOT against a list
      // of known values. Bands are an open scale server-side; an allowlist
      // would fail-open every call the day a new one ships, which is the very
      // bug this check exists to prevent.
      //
      // Validated through an untrusted view: `body` is typed as ScoreResponse,
      // so TypeScript would reject a check for a shape that type cannot hold —
      // which is exactly the shape a misbehaving server can send.
      const raw = body as unknown as Record<string, unknown>;
      if (
        typeof raw?.score !== "number" ||
        typeof raw?.tier !== "string" ||
        raw.tier === "" ||
        typeof raw?.deep_mode_active !== "boolean" ||
        typeof raw?.baseline_ready !== "boolean" ||
        typeof raw?.shadow_mode !== "boolean" ||
        !(Array.isArray(raw?.reasons) || raw?.reasons === null)
      ) {
        throw new VectoralError(
          "vectoral: response is not a score verdict (missing or malformed required fields)",
          { code: "invalid_response", status: 200, responseBody: JSON.stringify(body) },
        );
      }
      // Go marshals a nil slice as `null`; that is the server's own shape for
      // "no reasons", so normalise rather than hand the caller a null array.
      return raw.reasons === null ? { ...body, reasons: [] } : body;
    } catch (err) {
      if (!this.opts.failOpen || !(err instanceof VectoralError)) throw err;
      notifyError(this.opts.onError, err, "inference.score");
      return { ...FAIL_OPEN_SCORE, error: err };
    }
  }

  /**
   * Post-call token/cost telemetry. Call after the LLM responds.
   *
   * This is the feedback that makes every later score meaningful — it is where
   * token velocity and cost signals come from. It never fails open: telemetry
   * you silently drop is telemetry you never notice missing.
   */
  postCall(event: PostCallEvent): Promise<OkResponse> {
    return this.transport
      .post<OkResponse>("/v1/events/post-call", event, {
        idempotent: event.event_id !== undefined,
      })
      .then(assertAck);
  }

  /**
   * Consume `prompt_text_to_fingerprint` (always stripped from the wire,
   * enabled or not) and attach the computed block when fingerprinting is
   * active. The caller's object is never mutated.
   */
  private prepare(req: ScoreRequest): ScoreRequest {
    const { prompt_text_to_fingerprint: text, ...rest } = req.request;
    const out: ScoreRequest = { ...req, request: rest };
    const cfg = this.opts.fingerprint;
    if (!cfg) {
      if (text !== undefined && text !== "" && !this.warnedMissingFingerprintInput) {
        this.warnedMissingFingerprintInput = true;
        this.opts.onWarning?.(
          "request.prompt_text_to_fingerprint was supplied but prompt " +
            "fingerprinting is not configured — the text was stripped and no " +
            "fingerprint was sent. Set `fingerprint: { enabled: true, salt, saltId }`",
        );
      }
      return out;
    }
    // A caller who precomputed their own block (a proxy, a batch importer)
    // asked for exactly that. Recomputing over it would silently discard work
    // the docs tell them to do.
    if (rest.prompt_fingerprint !== undefined) return out;
    if (text === undefined || text === "") {
      if (!this.warnedMissingFingerprintInput) {
        this.warnedMissingFingerprintInput = true;
        this.opts.onWarning?.(
          "prompt fingerprinting is configured but this score() call has no " +
            "request.prompt_text_to_fingerprint — no fingerprint sent",
        );
      }
      return out;
    }
    const fp = computeFingerprint(text, cfg.salt, {
      minHash: true,
      global: cfg.shareGlobal,
    });
    // Under the 8-token floor there is not enough text for a stable
    // fingerprint; send nothing rather than something noisy.
    if (fp.tooShort) return out;
    const block: PromptFingerprintBlock = {
      v: 1,
      salt_id: cfg.saltId,
      simhash: fp.simhash!,
      exact_hash: fp.exactHash!,
      conversation_key: req.session_id ?? conversationKey(text, cfg.salt),
      minhash: fp.minhashB64!,
      band_keys: fp.bandKeys!,
    };
    if (cfg.shareGlobal) block.simhash_global = fp.simhashGlobal!;
    out.request = { ...rest, prompt_fingerprint: block };
    return out;
  }
}
