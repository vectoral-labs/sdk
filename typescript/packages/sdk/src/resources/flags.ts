// GET /v1/flags and GET /v1/flags/{id} — account flags. A flag records that
// an account's usage looks wrong. It never blocks anything; settle one with a
// label (`labels.submit({ flag_id })`).

import type { Transport } from "../http.js";
import { seg } from "../http.js";
import type { FlagLevel, FlagReason, FlagSource, FlagStatus, ReraiseCause } from "./shared.js";

/** One flag episode. Every string-valued set here is open. */
export interface AccountFlag {
  /** `flg_` and a number. */
  id: string;
  account_id: string;
  status: FlagStatus;
  /** `watch` or `flagged`. On `accounts.get()`, the account's level now. */
  level: FlagLevel;
  /** The highest level the flag reached. */
  peak_level?: FlagLevel | null;
  reasons: FlagReason[];
  /** What opened the flag. */
  source?: FlagSource | null;
  opened_at: string;
  /** Only on `accounts.get()`: when the account reached its current level. */
  level_since?: string;
  /** `null` while the flag is open. */
  closed_at?: string | null;
  /** Why the flag reopened soon after a dismissal. `null` otherwise. */
  reraise_cause?: ReraiseCause | null;
  previous_flag_id?: string | null;
}

export interface FlagListParams {
  status?: "open" | "expired" | "dismissed" | "confirmed";
  level?: "watch" | "flagged";
  account_id?: string;
  /** RFC 3339. Only flags opened at or after this time. */
  since?: string;
  /** 1–200. Default 50. Anything else is a 400. */
  limit?: number;
  /** `next_cursor` from the previous page. Opaque. */
  cursor?: string;
}

export interface FlagList {
  flags: AccountFlag[];
  /** Pass as `cursor` for the next page; `null` on the last page. */
  next_cursor: string | null;
}

export class Flags {
  constructor(private readonly transport: Transport) {}

  /**
   * One page of flags, newest first, open and closed. Filters are checked
   * strictly: a typo is a 400, not an empty list.
   */
  async list(params: FlagListParams = {}): Promise<FlagList> {
    const body = await this.transport.get<FlagList>("/v1/flags", { ...params });
    return body.flags === null ? { ...body, flags: [] } : body;
  }

  /**
   * Every flag matching `params`, following `next_cursor` page by page.
   * Pages are keyed so a flag opening mid-walk never repeats or drops a row.
   */
  async *iterate(params: Omit<FlagListParams, "cursor"> = {}): AsyncGenerator<AccountFlag> {
    let cursor: string | undefined;
    for (;;) {
      const page = await this.list({ ...params, ...(cursor !== undefined ? { cursor } : {}) });
      yield* page.flags;
      if (!page.next_cursor) return;
      cursor = page.next_cursor;
    }
  }

  /** One flag by id (`flg_1234`; a bare number works too). 404 if not yours. */
  async get(flagId: string): Promise<AccountFlag> {
    return this.transport.get<AccountFlag>(`/v1/flags/${seg(flagId)}`);
  }
}
