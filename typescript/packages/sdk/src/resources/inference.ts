// POST /v1/score and POST /v1/events/post-call — the per-inference pair.

import type { Transport } from "../http.js";
import { VectoralError, notifyError } from "../errors.js";
import { assertAck } from "../http.js";
import type { ResolvedFingerprintConfig } from "../salt.js";
import { computeFingerprint, conversationKey } from "../fingerprint/index.js";

/** Risk banding returned alongside the numeric score. */
export type Tier = "low" | "medium" | "high";

/**
 * Reason codes that can appear in a score response, as a hint for autocomplete.
 *
 * **This list is not exhaustive and cannot be made exhaustive.** Reasons are
 * produced by the scoring algorithm running server-side, which ships
 * independently of this package — a new one can appear in a response without an
 * SDK release. The `(string & {})` member is what makes that safe: an unlisted
 * code type-checks. It is also why you must not write an exhaustive `switch`
 * over this type, and why `reasons` is for your logs and support conversations
 * rather than for branching. `tier` is the field to act on.
 *
 * The algorithm returns at most three, ordered by contribution. Operational
 * codes are added on top, so a response can carry more than three.
 *
 * Listed below by where the code comes from, because the three groups behave
 * differently — an operational code means the verdict was overridden and the
 * algorithm's opinion is not what you are looking at. Most are prepended, but
 * `reputation_discount` is appended, so scan the whole array rather than
 * checking `reasons[0]`. See
 * `docs/concepts/inference-scoring.md` for what each one means.
 */
export type ReasonCode =
  // Account behaviour — the scoring algorithm's own findings. These are the
  // ordinary case, and the group that grows.
  | "machine_paced"
  | "hidden_telemetry"
  | "birth_cohort"
  | "probing"
  | "resource_shape"
  | "value_extraction"
  | "resource_extraction"
  | "datacenter_origin"
  | "account_risk"
  | "synthetic_noop"
  // Operational — these do not come from the algorithm. They are prepended when
  // something overrode or replaced the verdict, so they lead the list when they
  // appear, and the codes after them may be from a score that was not acted on.
  | "account_blocked"
  | "spend_cap_exceeded:account"
  | "spend_cap_exceeded:org"
  | "scoring_unavailable"
  | "reputation_discount"
  // Browser signals — present only when a verified sensor token was fused into
  // this score. Absent entirely if you have not deployed `@vectoral-labs/browser`.
  | "webdriver_present"
  | "automation_signature"
  | "headless_browser"
  | "no_accept_languages"
  | "missing_chrome_object"
  | "no_human_interaction"
  | "no_pointer_activity"
  | "cursor_teleport"
  | "thin_fingerprint"
  | (string & {});

/**
 * Account-context block. All fields optional but recommended.
 *
 * Both fields are sent verbatim in the request body — this block is context you
 * supply, not something derived from the prompt. Worth knowing if anything on
 * your egress path inspects outgoing bodies: a label you chose will appear in
 * them as plain text. See `docs/concepts/inference-scoring.md`.
 */
export interface AccountBlock {
  /** RFC 3339 timestamp of when the account first existed in your system. */
  first_seen?: string;
  /**
   * Customer-attested account facts. Every field is optional and an omitted
   * one means "not provided" — it is gated off rather than defaulted, so a
   * partial block is never read as a favourable answer.
   *
   * `plan_type`, `has_payment_method`, `email_verified`, `prior_chargeback`
   * and `billing_delinquent` feed the `account_risk` reason code.
   * `identity_verified` and `trust_label` do not — they only earn a trust
   * discount. Sent verbatim, like the rest of the block.
   */
  context?: AccountContextBlock;
  /**
   * Free-form tier label, e.g. "free" | "pro" | "enterprise". Sent as given;
   * use a stable internal label rather than anything user-supplied.
   */
  subscription_tier?: string;
}

/** Customer-attested account facts. See `AccountBlock.context`. */
export interface AccountContextBlock {
  /** "paid" | "unpaid" | "trial". Omit when unknown. */
  plan_type?: string;
  has_payment_method?: boolean;
  email_verified?: boolean;
  /** KYC / identity verification. */
  identity_verified?: boolean;
  prior_chargeback?: boolean;
  billing_delinquent?: boolean;
  /** e.g. "vip", "allowlisted", "allowlist", "trusted". Omit when none. */
  trust_label?: string;
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
  /**
   * The signed token from `/v1/sensor/collect`, forwarded by your backend.
   * The trusted, unforgeable way to join this call to the browser verdict —
   * it supersedes the plaintext `session_id` for fusion.
   *
   * Tokens are short-lived (~2 minutes). A token that fails verification or
   * has expired skips fusion ENTIRELY rather than falling back to
   * `session_id`, so a backend that caches one and forwards it later gets
   * less signal than sending none. Forward it on the next call or not at all.
   */
  sensor_token?: string;
  /**
   * Raw prompt text, read only when Deep Mode is enabled.
   *
   * IT IS SENT ON THE WIRE. Intended for self-hosted or in-VPC deployments
   * where the request never leaves your network — against the hosted API this
   * transmits the prompt to Vectoral. If what you want is prompt correlation
   * without sending text, that is `prompt_text_to_fingerprint` below, which is
   * hashed in-process and stripped from every request.
   */
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
  /**
   * Idempotency key. A repeat of the same `event_id` replays the stored
   * verdict and scores nothing, flagged as `duplicate` — useful when your own
   * caller may retry, since it stops one request being billed and recorded
   * twice.
   *
   * The replay is NOT byte-identical: `baseline_ready` and `blocked` are not
   * restored and come back `false` however the original came out. `score`,
   * `tier` and `reasons` ARE restored, so enforce a `duplicate: true` response
   * on those — a block forces `tier` to `high` before the verdict is stored.
   * This is also why `score()` does not retry internally even when you set
   * this.
   */
  event_id?: string;
}

export interface ScoreResponse {
  /** Calibrated [0,1] score. 0 = clean, 1 = certain fraud. */
  score: number;
  /**
   * Banding of `score`: medium at >=0.30, high at >=0.60.
   *
   * Not a pure function of `score`. Traffic that trips the automation floor is
   * lifted from low to medium whatever it scored, so a 0.05 can come back
   * `medium` — that is the system working, not a bug.
   */
  tier: Tier;
  /**
   * Up to 3 from the scoring algorithm, plus any operational codes. Note that
   * `reputation_discount` is appended rather than prepended, so checking only
   * `reasons[0]` for an override will miss it.
   */
  reasons: ReasonCode[];
  deep_mode_active: boolean;
  /** True when we are actively scoring: the verdict is live, not masked. */
  baseline_ready: boolean;
  /** True during the customer's warm-up window. The score is still real. */
  shadow_mode: boolean;
  /**
   * True when a hard control overrode the verdict — a manual block from the
   * dashboard, OR a tripped account/org spend cap. Check `reasons` for which:
   * `account_blocked` vs `spend_cap_exceeded:*`. Do not treat this as proof of
   * fraud; the tier is forced to `high` and the score to `1.0` either way.
   *
   * The tier is forced, so a guard on `tier === "high"` ALONE already refuses
   * these. But the usual guard also requires `baseline_ready`, which is false
   * throughout your warm-up window — so a combined condition lets a blocked
   * account through. Check this field on its own, before the risk branch.
   */
  blocked?: boolean;
  /** True when a browser sensor event was folded into this score. */
  signals_fused?: boolean;
  /** The standalone bot score for the joined session, when fused. */
  browser_score?: number;
  browser_decision?: string;
  /** True when this replays a stored verdict for the request's `event_id`. */
  duplicate?: boolean;
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
  /**
   * Send it when you measured it. Between this, `completion_tokens` and
   * `inference_cost_usd`, send at least one — see `inference_cost_usd` for
   * what omitting all three costs you.
   *
   * OMITTED AND ZERO ARE DIFFERENT. Omitted means "not measured"; `0` is real
   * evidence, and a zero completion count is one of the tells for synthetic
   * traffic. Do not write `completion_tokens: usage.output_tokens ?? 0` — for
   * a modality that produces no completion (embeddings, tts, stt, rerank)
   * that asserts a fraud signal. Omit the field instead.
   */
  prompt_tokens?: number;
  /** Send it when you measured it. See `prompt_tokens`. */
  completion_tokens?: number;
  latency_ms?: number;
  /**
   * If omitted, the server computes cost from its bundled rate table — but
   * only when a token count is present and non-zero.
   *
   * Unlike the token counts above, this is NOT absent-vs-zero: omit all three
   * and a cost of `0` is recorded, which reads as zero-value evidence, the
   * same fraud tell the token counts warn about. Send a token count or an
   * explicit cost.
   */
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
        // DELIBERATELY false even when `event_id` is set, which is not the
        // pattern the other endpoints follow. The server's replay response is
        // built field by field and does not carry `baseline_ready` or
        // `blocked`, so a replayed verdict reports both as `false` whatever
        // they really were. Retrying here would therefore turn a timeout into
        // a verdict that silently fails the usual enforcement guard — worse
        // than the fail-open zero it was meant to avoid. Revisit when the
        // replay path returns a complete verdict.
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
