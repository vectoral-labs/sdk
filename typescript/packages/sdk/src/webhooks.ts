// Receiving Vectoral webhooks: signature verification and event types.
//
// The scheme: `x-vectoral-signature: t=<unix seconds>,v1=<hex>[,v1=<hex>…]`,
// where each v1 is hex(HMAC-SHA256(secret, "<t>.<raw body>")) under the
// endpoint's `whsec_…` secret, used as-is (the whole string, not decoded).
// During a secret rotation a request carries one v1 per secret, new first.
//
// This mirrors the normative Go verifier rule for rule, including its parse:
// split on `,`, trim each part, split it at the first `=`; a part with no `=`
// is malformed, `t` must be a base-10 integer (the last `t` wins), unknown
// keys are ignored, and the signature is recomputed over the CANONICAL form
// of `t` — so `t=+017…` verifies against the digits of the number, not the
// text sent. The golden vectors in `testdata/webhook_vectors.json` are the
// contract.
//
// Uses Web Crypto (`globalThis.crypto.subtle`), so it runs on Node 20+, Deno,
// Bun and edge runtimes, and is async for that reason.

import type {
  Action,
  ActionReason,
  FlagLevel,
  FlagReason,
  LabelReasonCode,
  RegistrationReason,
  ReraiseCause,
} from "./resources/shared.js";

/** The header carrying the signature. Lower-case, as sent. */
export const WEBHOOK_SIGNATURE_HEADER = "x-vectoral-signature";
/** The header carrying the event type, the same as `type` in the body. */
export const WEBHOOK_EVENT_HEADER = "x-vectoral-event";
/** The header carrying the delivery id: stable across retries of one delivery. */
export const WEBHOOK_DELIVERY_HEADER = "x-vectoral-delivery";
/** How far `t` may be from your clock, either way, before it is refused. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * Why verification failed.
 *
 * - `malformed`: the header is missing, empty, or not `t=…,v1=…`.
 * - `stale`: `t` is more than the tolerance from your clock. Checked before
 *   the signature, as the reference verifier does.
 * - `mismatch`: no `v1` matches. Usually the wrong secret, or a body that was
 *   parsed and re-serialised before verification.
 */
export type WebhookVerificationFailure = "malformed" | "stale" | "mismatch";

export class WebhookVerificationError extends Error {
  readonly reason: WebhookVerificationFailure;

  constructor(reason: WebhookVerificationFailure, message: string) {
    super(message);
    this.name = "WebhookVerificationError";
    this.reason = reason;
  }
}

export interface VerifyWebhookOptions {
  /**
   * The request body **exactly as received** — raw bytes, or the raw text.
   * Not `JSON.stringify(req.body)`: a parsed-and-reserialised body differs
   * in whitespace and key order and will never verify.
   */
  payload: string | Uint8Array;
  /** The `x-vectoral-signature` header value. */
  header: string | null | undefined;
  /**
   * Your endpoint's `whsec_…` secret. Pass several to accept any of them,
   * e.g. while you roll a new secret out to your own fleet.
   */
  secret: string | readonly string[];
  /** Default 300 (5 minutes). */
  toleranceSeconds?: number;
  /** The clock to check `t` against. Default: now. */
  now?: Date;
}

const encoder = new TextEncoder();
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** Parse the header the way the reference verifier does. */
function parseHeader(header: string): { t: bigint; sigs: string[] } {
  const malformed = () =>
    new WebhookVerificationError("malformed", "vectoral webhook: malformed signature header");
  let t: bigint | undefined;
  const sigs: string[] = [];
  for (const raw of header.split(",")) {
    const part = raw.trim();
    const eq = part.indexOf("=");
    if (eq < 0) throw malformed();
    const k = part.slice(0, eq);
    const v = part.slice(eq + 1);
    if (k === "t") {
      if (!/^[+-]?[0-9]+$/.test(v)) throw malformed();
      const n = BigInt(v.startsWith("+") ? v.slice(1) : v);
      if (n < INT64_MIN || n > INT64_MAX) throw malformed();
      t = n;
    } else if (k === "v1") {
      sigs.push(v);
    }
  }
  if (t === undefined || sigs.length === 0) throw malformed();
  return { t, sigs };
}

function toBytes(payload: string | Uint8Array): Uint8Array {
  return typeof payload === "string" ? encoder.encode(payload) : payload;
}

type Subtle = typeof crypto.subtle;

function subtle(): Subtle {
  const s = (globalThis as { crypto?: { subtle?: Subtle } }).crypto?.subtle;
  if (!s) {
    throw new Error("vectoral webhook: Web Crypto (globalThis.crypto.subtle) is not available");
  }
  return s;
}

async function hmacHex(secret: string, t: bigint, body: Uint8Array): Promise<string> {
  const key = await subtle().importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const prefix = encoder.encode(`${t.toString()}.`);
  const msg = new Uint8Array(prefix.length + body.length);
  msg.set(prefix, 0);
  msg.set(body, prefix.length);
  const mac = new Uint8Array(await subtle().sign("HMAC", key, msg));
  let hex = "";
  for (const b of mac) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** Constant-time for equal lengths; a length difference is not a secret. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a webhook's signature. Resolves when it is genuine; rejects with a
 * `WebhookVerificationError` (see `reason`) when it is not. Respond with a
 * 4xx on rejection and do not process the body.
 */
export async function verifyWebhookSignature(opts: VerifyWebhookOptions): Promise<void> {
  if (typeof opts.header !== "string") {
    throw new WebhookVerificationError(
      "malformed",
      `vectoral webhook: missing ${WEBHOOK_SIGNATURE_HEADER} header`,
    );
  }
  const { t, sigs } = parseHeader(opts.header);

  const toleranceMs = (opts.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS) * 1000;
  const nowMs = (opts.now ?? new Date()).getTime();
  const ageMs = nowMs - Number(t) * 1000;
  if (ageMs > toleranceMs || ageMs < -toleranceMs) {
    throw new WebhookVerificationError(
      "stale",
      "vectoral webhook: signature timestamp outside tolerance",
    );
  }

  const body = toBytes(opts.payload);
  const secrets = typeof opts.secret === "string" ? [opts.secret] : opts.secret;
  for (const secret of secrets) {
    const want = await hmacHex(secret, t, body);
    // Every candidate is compared, match or not, so timing does not reveal
    // which position matched.
    let ok = false;
    for (const s of sigs) ok = timingSafeEqual(s, want) || ok;
    if (ok) return;
  }
  throw new WebhookVerificationError("mismatch", "vectoral webhook: no signature matches");
}

/**
 * Verify a webhook and parse its body. Rejects exactly as
 * `verifyWebhookSignature()` does, and never parses an unverified body.
 *
 * Deliveries are at least once: deduplicate on the envelope's `id`.
 */
export async function parseWebhook(opts: VerifyWebhookOptions): Promise<WebhookEnvelope> {
  await verifyWebhookSignature(opts);
  const text =
    typeof opts.payload === "string" ? opts.payload : new TextDecoder().decode(opts.payload);
  return JSON.parse(text) as WebhookEnvelope;
}

/**
 * Build an `x-vectoral-signature` header for `payload`, as Vectoral would.
 * For testing your own receiver; production signatures come from Vectoral.
 */
export async function signWebhookPayload(
  secret: string | readonly string[],
  payload: string | Uint8Array,
  timestamp: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const t = BigInt(Math.trunc(timestamp));
  const body = toBytes(payload);
  const secrets = typeof secret === "string" ? [secret] : secret;
  let header = `t=${t.toString()}`;
  for (const s of secrets) header += `,v1=${await hmacHex(s, t, body)}`;
  return header;
}

// ---------------------------------------------------------------------------
// Event types

/** The event types. An open set: ignore a type you don't know, with a 2xx. */
export type WebhookEventType =
  | "account.flagged"
  | "account.flag_dismissed"
  | "account.flag_confirmed"
  | "account.flag_expired"
  | "account.review_completed"
  | "registration.review_requested"
  | "registration.review_decided"
  | "ping"
  | (string & {});

/** Every webhook body. */
export interface WebhookEnvelope<
  TType extends string = WebhookEventType,
  TData = Record<string, unknown>,
> {
  /** `evt_…`. The same on every retry and resend: deduplicate on it. */
  id: string;
  type: TType;
  /** When the event happened. Order of arrival is not guaranteed. */
  created_at: string;
  /** `v1`. */
  api_version: string;
  customer_id: string;
  /** Fields can be added at any time. */
  data: TData;
}

/** Links for your team. Absent when no dashboard URL is configured. */
export interface WebhookLinks {
  dashboard?: string;
}

/** How much IP, country and user-agent data the calls carried. An open set. */
export type WebhookOriginData = "ok" | "partial" | "missing" | (string & {});
/** Where a verdict was made. An open set. */
export type WebhookChannel = "api" | "dashboard" | (string & {});
/** Who made a verdict. An open set. */
export type WebhookActorType = "api_key" | "user" | "staff" | "case" | (string & {});

export interface AccountFlaggedData {
  flag_id: string;
  account_id: string;
  level: FlagLevel;
  previous_level: FlagLevel;
  /** `rule` or `model_escalated`. An open set. */
  source: "rule" | "model_escalated" | (string & {});
  reasons: FlagReason[];
  opened_at: string;
  previous_flag_id?: string;
  reraise_cause?: ReraiseCause;
  /** A few counts for the account. The keys can grow. */
  summary?: Record<string, number>;
  origin_data: WebhookOriginData;
  links?: WebhookLinks;
}

export interface AccountFlagDismissedData {
  flag_id: string;
  account_id: string;
  channel: WebhookChannel;
  actor_type: WebhookActorType;
  reason_code?: LabelReasonCode;
  cleared_reasons: FlagReason[];
  suppressed_until?: Record<string, string>;
  remaining_reasons: FlagReason[];
  links?: WebhookLinks;
}

export interface AccountFlagConfirmedData {
  flag_id: string;
  account_id: string;
  channel: WebhookChannel;
  actor_type: WebhookActorType;
  links?: WebhookLinks;
}

export interface AccountFlagExpiredData {
  flag_id: string;
  account_id: string;
  links?: WebhookLinks;
}

export interface ReviewFinding {
  /** An open set of finding codes. */
  code?: string;
  direction?: "supports" | "contradicts" | "neutral" | (string & {});
}

/** Vectoral's model review, as codes and counts. All sets are open. */
export interface ReviewModel {
  summary_disposition?: "compromised_key" | "fraud" | "benign" | "inconclusive" | (string & {});
  evidence_confidence?: "strong" | "moderate" | "weak" | "conflicting" | (string & {});
  suggested_next_step?:
    | "no_action"
    | "confirm_with_owner"
    | "rotate_key_and_notify_owner"
    | "suspend_account"
    | (string & {});
  agrees_with_level?: boolean;
  items_verified?: number;
  items_total?: number;
  manipulation_attempt_observed?: boolean;
  escalated?: boolean;
}

export interface AccountReviewCompletedData {
  flag_id: string;
  account_id: string;
  level: FlagLevel;
  reasons: FlagReason[];
  deterministic: { findings?: ReviewFinding[] };
  /** `null` when no model review stands. */
  model: ReviewModel | null;
  origin_data: WebhookOriginData;
  /** Always `true`: a review never clears, labels or blocks anything. */
  advisory: boolean;
  links?: WebhookLinks;
}

export interface RegistrationReviewRequestedData {
  registration_id: string;
  action: Action;
  action_reason: ActionReason;
  score: number;
  tier: number;
  reasons: RegistrationReason[];
  /** The screening status, or `""` when the signup wasn't screened. */
  screening_status: "clear" | "hit" | "cleared" | "unavailable" | "" | (string & {});
}

export interface RegistrationReviewDecidedData {
  registration_id: string;
  decision: "allow" | "block" | (string & {});
  /** The name of the person who decided. */
  decided_by: string;
  decided_at: string;
}

export interface PingData {
  endpoint_id: string;
  message: string;
}

/** The `data` shape for each known event type. */
export interface WebhookEventDataMap {
  "account.flagged": AccountFlaggedData;
  "account.flag_dismissed": AccountFlagDismissedData;
  "account.flag_confirmed": AccountFlagConfirmedData;
  "account.flag_expired": AccountFlagExpiredData;
  "account.review_completed": AccountReviewCompletedData;
  "registration.review_requested": RegistrationReviewRequestedData;
  "registration.review_decided": RegistrationReviewDecidedData;
  ping: PingData;
}

/**
 * Narrow an envelope to one known event type:
 *
 * ```ts
 * if (isWebhookEvent(event, "account.flagged")) event.data.reasons;
 * ```
 *
 * The type set is open, so keep a default branch that acknowledges events
 * you don't handle.
 */
export function isWebhookEvent<K extends keyof WebhookEventDataMap>(
  event: WebhookEnvelope,
  type: K,
): event is WebhookEnvelope & WebhookEnvelope<K, WebhookEventDataMap[K]> {
  return event.type === type;
}
