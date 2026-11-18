// POST /v1/registrations/score — screen a signup BEFORE the account exists —
// and the per-registration routes that follow it: read the verdict back,
// report a step-up, label the signup, and work its sanctions screening.

import type { Transport } from "../http.js";
import { assertAck, seg } from "../http.js";
import { VectoralError, notifyError } from "../errors.js";
import type { Action, ActionReason, RegistrationReason } from "./shared.js";

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

/** A postal address, for sanctions screening. All fields optional. */
export interface RegistrationAddress {
  line1?: string;
  city?: string;
  /**
   * Must be an ISO 3166-2 code of `country`'s own subdivisions (such as
   * `UA-43` for `UA`) to drive the embargo check. Free text is stored and
   * shown to a reviewer but cannot be matched.
   */
  region?: string;
  postal_code?: string;
  /** ISO 3166-1 alpha-2. */
  country?: string;
}

/**
 * Who is registering, for sanctions screening. Read only when screening is on
 * for your organisation. A malformed field is never a 400: it is ignored for
 * matching and recorded in the screening's `input_warnings`.
 */
export interface RegistrationIdentity {
  full_name?: string;
  company_name?: string;
  /** `YYYY`, `YYYY-MM` or `YYYY-MM-DD`. Corroborates a name match only. */
  date_of_birth?: string;
  /** ISO 3166-1 alpha-2. Corroborates a match; never an embargo input. */
  nationality?: string;
  address?: RegistrationAddress;
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
  /** Who is registering, for sanctions screening. */
  identity?: RegistrationIdentity;
  /**
   * Whole-call budget in ms for the server's external lookups. Defaults to 400
   * server-side and is clamped to [250, 6000] rather than rejected. The SDK
   * keeps its own HTTP timeout above whatever you set here, with room for
   * the up-to-~750 ms of work the server does outside this budget.
   *
   * The 6s ceiling is a ceiling, not a recommendation — most integrations
   * should stay near the 400ms default. A tight deadline costs first-sightings
   * of a domain, not correctness.
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

/** One sanctions list version a screening ran against. */
export interface ScreeningListVersion {
  /** `ofac_sdn` or `ofac_consolidated` today. An open set. */
  source?: string;
  version?: string;
  published_at?: string;
}

/** A sanctions list match at or above your threshold. */
export interface ScreeningMatch {
  source?: string;
  /** The list's id for the entry. The handle for `createClearance()`. */
  entry_uid?: string;
  /** `individual`, `entity`, `vessel`, `aircraft` or `unknown`. An open set. */
  entry_type?: string;
  /** The listed primary name. */
  name?: string;
  /** The listed name that matched. Absent on an email- or website-only match. */
  matched_alias?: string;
  /** `name`, `date_of_birth`, `country`, `email`, `website`. An open set. */
  matched_on?: string[];
  score?: number;
  programs?: string[];
  /** True when an active clearance covers this match. */
  cleared?: boolean;
}

/** The location check. */
export interface ScreeningEmbargo {
  /** `hit`, `clear` or `unknown`. An open set. */
  status: "hit" | "clear" | "unknown" | (string & {});
  /** On a `hit`, the country that tripped it. */
  country?: string;
  /** On a `hit`, optionally the ISO 3166-2 code. */
  region?: string;
  /** On a `hit`: `ip`, `declared` or `address`. An open set. */
  basis?: string;
}

/**
 * Screening outcome. An open set.
 *
 * - `clear`: no list match and no embargo hit.
 * - `hit`: an uncleared list match, or an embargo hit.
 * - `cleared`: list matches, all cleared by a reviewer, and no embargo hit.
 * - `unavailable`: Vectoral couldn't screen. Never reads as `clear`; fall back
 *   to your own check if screening is a compliance duty for you.
 * - `not_screened`: screening isn't on for your organisation.
 */
export type ScreeningStatus =
  | "clear"
  | "hit"
  | "cleared"
  | "unavailable"
  | "not_screened"
  | (string & {});

/** The sanctions-screening block on a signup verdict. */
export interface Screening {
  status: ScreeningStatus;
  /** `scr_…`. Absent for `not_screened`. */
  screening_id?: string;
  list_versions?: ScreeningListVersion[];
  /** Absent when there are none. */
  matches?: ScreeningMatch[];
  embargo?: ScreeningEmbargo;
}

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
  /**
   * Contributing facts, most significant first. Do not branch on these.
   * Typed as `string[]` for compatibility; see `RegistrationReason` for the
   * known values.
   */
  reasons: string[];
  /** True on an idempotent replay of a previous `event_id`. */
  duplicate?: boolean;
  /**
   * True while your organisation is in shadow mode. Without the Action
   * Policy, `tier` is then pinned to 0; with it, the real tier comes back and
   * `action` is `allow`.
   */
  shadow_mode?: boolean;
  /**
   * The Action Policy's decision. Present only when the Action Policy is on
   * for your organisation; when it is, act on this rather than on `tier`.
   * **An open set: treat a value you don't recognise as `allow`.**
   */
  action?: Action;
  /** Why `action` was chosen. An open set. */
  action_reason?: ActionReason;
  /**
   * In shadow mode, what the policy would have done. When a sanctions outcome
   * is live in shadow mode, `action` is that outcome and this is the stronger
   * one the rest of the policy reached.
   */
  policy_action?: Action;
  /**
   * Present next to a `step_up` (or a `policy_action` of `step_up`): your
   * current "When step-up fails" setting, `review` or `block`. When `action`
   * is `step_up`, run the step-up and report it with `reportStepUp()`.
   */
  step_up_fails?: "review" | "block" | (string & {});
  /**
   * The sanctions-screening outcome. The API always sends it
   * (`{ status: "not_screened" }` unless you opted in); absent here only on a
   * fail-open verdict, where nothing was screened.
   */
  screening?: Screening;
  /**
   * The API's `degraded` list: facts whose evidence was incomplete because a
   * lookup Vectoral owns failed. Absent when nothing degraded.
   *
   * Renamed in the SDK because `degraded` already means "this verdict is the
   * SDK's fail-open stand-in" (below), and changing that field's type would
   * break every caller that checks it.
   */
  degraded_facts?: RegistrationReason[];
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

/** Wire shape, before the SDK moves `degraded` and adds its own. */
type RegistrationResponseBody = Omit<
  RegistrationVerdict,
  "reasons" | "degraded" | "degraded_facts" | "error" | "registration_id"
> & {
  registration_id: string;
  reasons: string[] | null;
  degraded?: RegistrationReason[];
};

/**
 * A stored signup verdict, from `registrations.get()`. The action is the one
 * stored now, which a failed step-up can have moved; a team's review decision
 * never changes it and appears as `review_decision` instead.
 */
export interface RegistrationDetail {
  registration_id: string;
  tier: number;
  /** Masked to 0 under the same rule as `tier`. */
  score: number;
  /** `null` from the API is normalised to `[]`. */
  reasons: RegistrationReason[];
  /** The API's `degraded` list (here there is no SDK flag to collide with). */
  degraded?: RegistrationReason[];
  /** The algorithm revision that produced the verdict. */
  algo_version: string;
  /**
   * True when scored in shadow mode. Without the Action Policy, `tier`,
   * `score` and `reasons` are then withheld, as the scoring response did.
   */
  shadow_mode: boolean;
  received_at: string;
  /** The account `identity.record()` linked, or `null` with no link yet. */
  linked_account_id: string | null;
  linked_at: string | null;
  action?: Action;
  action_reason?: ActionReason;
  policy_action?: Action;
  /** Present once you report the step-up. An open set. */
  step_up_result?: "passed" | "failed" | (string & {});
  /** Present once your team decides a signup sent to review. An open set. */
  review_decision?: "allow" | "block" | (string & {});
}

/** Body of POST /v1/registrations/{id}/step-up. */
export interface StepUpReport {
  /** Whether the user completed the step-up. */
  passed: boolean;
}

export interface StepUpResult {
  registration_id: string;
  passed: boolean;
  /**
   * The action now stored: `step_up` after a pass, your "When step-up fails"
   * setting (`review` or `block`) after a failure.
   */
  action: Action;
}

/** Body of POST /v1/registrations/{id}/label. */
export interface RegistrationLabelRequest {
  label: "fraud" | "legitimate";
  notes?: string;
}

export interface RegistrationLabelResponse {
  ok: boolean;
  registration_id: string;
  label: "fraud" | "legitimate" | (string & {});
  submitted_at: string;
}

/** A field of `identity` ignored as malformed when screening. */
export interface ScreeningInputWarning {
  /** e.g. `identity.date_of_birth`. */
  field?: string;
  /** `unparseable`, `not_iso_alpha2`, `too_long`, `wrong_type`, `entitlement_unknown`. An open set. */
  reason?: string;
}

/**
 * The audit record of one registration's sanctions screening: the `screening`
 * block as returned, plus what was screened and how.
 */
export interface ScreeningAudit extends Screening {
  screened_at?: string;
  /**
   * **What was screened, in plaintext.** Personal data — treat it that way.
   */
  input?: {
    email?: string;
    identity?: RegistrationIdentity;
    normalized_name?: string;
    normalized_company?: string;
    /** The countries and regions used for the embargo check. */
    location?: Record<string, string>;
  };
  input_warnings?: ScreeningInputWarning[];
  /** Your settings at the time of screening. */
  options?: {
    lists?: string[];
    threshold?: number;
    block_on_list_hit?: boolean;
    block_on_embargo?: boolean;
    embargo?: string[];
    list_versions?: ScreeningListVersion[];
  };
  /** Whether a sanctions floor was demanded for this signup. */
  blocked?: boolean;
  /** The matcher that produced it. */
  screener?: string;
}

/** Body of POST /v1/registrations/{id}/screening/clearances. */
export interface ClearanceRequest {
  /** The `entry_uid` of a match on this registration's stored screening. */
  entry_uid: string;
  /** Why. Trimmed; must be non-empty, at most 1000 bytes. */
  note: string;
}

export interface ClearanceResponse {
  ok: boolean;
  clearance: {
    entry_uid?: string;
    source?: string;
    created_at?: string;
  };
}

export interface ClearanceRevokeResponse {
  ok: boolean;
  /** `false` when there was no active clearance to revoke. */
  revoked: boolean;
}

const DEADLINE_MIN_MS = 250;
// Matches the server's ceiling. If these drift apart the SDK aborts a request
// the server is still working on, which is the exact fail-open this file exists
// to prevent — previously 2000 against a server ceiling of 6000.
const DEADLINE_MAX_MS = 6000;
/**
 * Headroom over the server-side deadline. The server's domain rules (up to
 * 250 ms) and the save (up to 500 ms) run OUTSIDE `deadline_ms`, so it can
 * answer ~750 ms after the budget runs out; the rest is TLS, queueing and the
 * response. At 300 the SDK aborted signups the server was about to answer.
 */
const DEADLINE_OVERHEAD_MS = 1000;

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
      // Everything the server sent passes through, so a field added to the
      // API reaches the caller without an SDK release. Only `degraded` moves:
      // the API's list goes to `degraded_facts`, because `degraded` here is
      // the SDK's own fail-open flag.
      const { degraded: facts, reasons, ...rest } = body;
      return {
        ...rest,
        reasons: reasons ?? [],
        ...(facts !== undefined ? { degraded_facts: facts } : {}),
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

  /**
   * Read back a stored verdict, for a later decision that should not score
   * again (an onboarding credit grant, a reconciler). Throws on any failure,
   * including 404 for an unknown id — a read used for a decision must not
   * quietly turn into "allow".
   */
  async get(registrationId: string): Promise<RegistrationDetail> {
    const body = await this.transport.get<RegistrationDetail>(
      `/v1/registrations/${seg(registrationId)}`,
    );
    const raw = body as unknown as Record<string, unknown>;
    if (typeof raw?.tier !== "number" || typeof raw?.score !== "number") {
      throw new VectoralError(
        "vectoral: response is not a registration (missing numeric `tier`/`score`)",
        { code: "invalid_response", status: 200, responseBody: JSON.stringify(body) },
      );
    }
    return raw.reasons === null ? { ...body, reasons: [] } : body;
  }

  /**
   * Report whether a signup told `step_up` passed it. A failure carries out
   * your "When step-up fails" setting (review queue or block).
   *
   * Not retried: the call carries no idempotency key, and a second report
   * is refused with 409. A 409 also means the signup was not told `step_up`
   * (one scored in shadow mode was told `allow`).
   */
  async reportStepUp(registrationId: string, report: StepUpReport): Promise<StepUpResult> {
    const body = await this.transport.post<StepUpResult>(
      `/v1/registrations/${seg(registrationId)}/step-up`,
      { passed: report.passed },
      { idempotent: false },
    );
    if (typeof (body as { action?: unknown })?.action !== "string") {
      throw new VectoralError(
        "vectoral: response is not a step-up result (missing `action`)",
        { code: "invalid_response", status: 200, responseBody: JSON.stringify(body) },
      );
    }
    return body;
  }

  /**
   * Label a scored signup as fraud or legitimate — including one that never
   * became an account, which `labels.submit()` cannot describe. Append-only:
   * the most recent label wins. Not retried (no idempotency key).
   */
  async label(
    registrationId: string,
    req: RegistrationLabelRequest,
  ): Promise<RegistrationLabelResponse> {
    return this.transport
      .post<RegistrationLabelResponse>(
        `/v1/registrations/${seg(registrationId)}/label`,
        req,
        { idempotent: false },
      )
      .then(assertAck);
  }

  /**
   * The sanctions-screening audit record for one registration. A plain 404
   * when screening is off for your organisation, the id is unknown, or the
   * signup was never screened.
   */
  async getScreening(registrationId: string): Promise<ScreeningAudit> {
    return this.transport.get<ScreeningAudit>(
      `/v1/registrations/${seg(registrationId)}/screening`,
    );
  }

  /**
   * Clear a sanctions match as a false positive. Keyed on the email, the
   * screened name and the list entry, so it applies to later registrations by
   * the same person too. Never changes a verdict already returned. Not retried
   * (no idempotency key).
   */
  async createClearance(registrationId: string, req: ClearanceRequest): Promise<ClearanceResponse> {
    return this.transport
      .post<ClearanceResponse>(
        `/v1/registrations/${seg(registrationId)}/screening/clearances`,
        req,
        { idempotent: false },
      )
      .then(assertAck);
  }

  /**
   * Revoke the clearance for a list entry, found through this registration's
   * stored match. `revoked` is `false` when there was nothing to revoke.
   */
  async revokeClearance(registrationId: string, entryUid: string): Promise<ClearanceRevokeResponse> {
    return this.transport
      .delete<ClearanceRevokeResponse>(
        `/v1/registrations/${seg(registrationId)}/screening/clearances/${seg(entryUid)}`,
        { idempotent: false },
      )
      .then(assertAck);
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
