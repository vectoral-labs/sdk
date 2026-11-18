// /v1/accounts — read accounts and their score history, send account context
// and payment events, and read your organisation's totals (/v1/stats).

import type { Transport } from "../http.js";
import { assertAck, seg } from "../http.js";
import type { AccountContextBlock, OkResponse, ReasonCode, Tier } from "./inference.js";
import type { AccountFlag } from "./flags.js";
import type { RegistrationDetail } from "./registrations.js";
import type { FlagLevel } from "./shared.js";
import type { Label } from "./labels.js";

/** Lookback for cost and usage rollups. */
export type AccountWindow = "1h" | "1d" | "7d" | "30d";

export interface AccountListParams {
  /** Page size, capped at 200. Default 50. */
  limit?: number;
  offset?: number;
  /** Default `score`. Never-scored accounts sort last. */
  sort?: "score" | "last_seen" | "first_seen" | "requests";
  /** Default `desc`. */
  order?: "asc" | "desc";
  label?: "fraud" | "legitimate" | "unlabeled";
  /** Only accounts whose `subscription_tier` equals this exactly. */
  tier?: string;
  /** Only accounts whose latest score is at least this. Leaves out never-scored ones. */
  min_score?: number;
  flag_level?: "watch" | "flagged" | "any";
  /** Lookback for `inference_cost_usd`. Default `30d`. */
  window?: AccountWindow;
}

/** One account and its most recent score. Fields with no value are `null`. */
export interface AccountListItem {
  account_id: string;
  first_seen: string;
  last_seen: string;
  subscription_tier: string | null;
  request_count: number;
  last_label: Label | null;
  last_label_at: string | null;
  /** `null` means the account was never scored. */
  latest_score: number | null;
  latest_tier: Tier | null;
  scored_at: string | null;
  /** Cost from post-call events over `window`. */
  inference_cost_usd: number;
  /** `null` for an account the flag rules haven't evaluated yet. */
  flag_level?: FlagLevel | null;
  /** The open flag, or `null` at `normal`. */
  flag_id?: string | null;
}

export interface AccountList {
  accounts: AccountListItem[];
  /** The match count, ignoring `limit` and `offset`. */
  total: number;
  limit: number;
  offset: number;
}

/** A past score: the `/v1/score` fields minus `baseline_ready`. */
export interface ScoreSummary {
  score: number;
  tier: Tier;
  reasons: ReasonCode[];
  received_at: string;
  shadow_mode: boolean;
  deep_mode_active: boolean;
}

export interface AccountDetail {
  account_id: string;
  first_seen: string;
  last_seen: string;
  subscription_tier?: string;
  request_count: number;
  /** The latest behavioural verdict, or `null` if never scored. */
  latest_score: ScoreSummary | null;
  /**
   * The signup verdict linked to this account, or `null` when none is. Same
   * shape and masking as `registrations.get()`.
   */
  registration: RegistrationDetail | null;
  /** Post-call totals over the lookback. All zeros when there are none. */
  window: {
    events: number;
    prompt_tokens: number;
    completion_tokens: number;
    inference_cost_usd: number;
  };
  model_mix: { model: string; count: number }[];
  /** The open flag, or `null` at `normal`. Carries `level_since`. */
  flag: AccountFlag | null;
}

/** One past `/v1/score` call. Fields with no value are `null`. */
export interface ScoreHistoryItem {
  id: number;
  session_id: string | null;
  received_at: string;
  ip: string | null;
  model_requested: string | null;
  estimated_prompt_tokens: number | null;
  score: number | null;
  tier: Tier | null;
  reasons: ReasonCode[];
  shadow_mode: boolean;
  deep_mode_active: boolean;
}

export interface AccountScoreList {
  scores: ScoreHistoryItem[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * The kind of payment event. Any other value is a 400, so this is a closed
 * set on the request side.
 */
export type CommerceEventType =
  | "funding_succeeded"
  | "payment_attempted"
  | "payment_declined"
  | "refund"
  | "chargeback";

/** Body of POST /v1/accounts/{id}/commerce. */
export interface CommerceEvent {
  /** Required. Unique within your organisation; makes retries safe. */
  event_id: string;
  event_type: CommerceEventType;
  amount_usd?: number;
  /**
   * A 64-character lowercase hex digest YOU compute from a stable instrument
   * id (card fingerprint, payment-method id). **Never a raw instrument.**
   * Anything else is a 400.
   */
  instrument_hash?: string;
  /** RFC 3339. Defaults to now; not in the future, not older than 400 days. */
  event_time?: string;
}

/** Your organisation's totals. */
export interface Stats {
  total_accounts: number;
  high_risk_accounts: number;
  medium_risk_accounts: number;
  low_risk_accounts: number;
  unscored_accounts: number;
  labeled_fraud: number;
  labeled_legitimate: number;
  unlabeled: number;
  /** Score requests stored in the last 24 hours. */
  scores_24h: number;
  /** Post-call events stored in the last 24 hours. */
  events_24h: number;
}

const nullToEmpty = <T extends { reasons: unknown }>(row: T): T =>
  row.reasons === null ? { ...row, reasons: [] } : row;

export class Accounts {
  constructor(private readonly transport: Transport) {}

  /**
   * A page of accounts with their latest score. Filters are checked strictly:
   * a value that isn't allowed is a 400, not an empty list.
   */
  list(params: AccountListParams = {}): Promise<AccountList> {
    return this.transport.get<AccountList>("/v1/accounts", { ...params });
  }

  /**
   * Everything held on one account: latest score, linked signup verdict,
   * usage rollup, model mix and open flag. 404 for an unknown account.
   */
  async get(accountId: string, params: { window?: AccountWindow } = {}): Promise<AccountDetail> {
    const body = await this.transport.get<AccountDetail>(
      `/v1/accounts/${seg(accountId)}`,
      { ...params },
    );
    return {
      ...body,
      latest_score: body.latest_score ? nullToEmpty(body.latest_score) : body.latest_score,
      registration: body.registration ? nullToEmpty(body.registration) : body.registration,
    };
  }

  /**
   * The account's `/v1/score` history, newest first. An account with no
   * history returns an empty page, not a 404.
   */
  async scores(
    accountId: string,
    params: { limit?: number; offset?: number } = {},
  ): Promise<AccountScoreList> {
    const body = await this.transport.get<AccountScoreList>(
      `/v1/accounts/${seg(accountId)}/scores`,
      { ...params },
    );
    return { ...body, scores: (body.scores ?? []).map(nullToEmpty) };
  }

  /**
   * Save facts about an account Vectoral can't see. Merged: a field you omit
   * keeps its stored value. The same object can go inline as
   * `account.context` on `inference.score()`, where it overrides for that
   * call. Not retried: the call takes no idempotency key.
   */
  async setContext(accountId: string, context: AccountContextBlock): Promise<OkResponse> {
    return this.transport
      .post<OkResponse>(`/v1/accounts/${seg(accountId)}/context`, context, {
        idempotent: false,
      })
      .then(assertAck);
  }

  /**
   * Record a payment event. Stored now, not yet scored. `event_id` is
   * required, so a transient failure is retried. Never fails open.
   */
  async recordCommerce(accountId: string, event: CommerceEvent): Promise<OkResponse> {
    return this.transport
      .post<OkResponse>(`/v1/accounts/${seg(accountId)}/commerce`, event, {
        // Required by the API, but checked rather than assumed: an untyped
        // caller that leaves it out gets a 400, never a blind retry.
        idempotent: event.event_id !== undefined,
      })
      .then(assertAck);
  }

  /** Your organisation's totals: accounts per tier, labels, last-24h volume. */
  stats(): Promise<Stats> {
    return this.transport.get<Stats>("/v1/stats");
  }
}
