// POST /v1/labels — ground truth. This is what the models train on, and the
// call that settles an account flag.

import type { Transport } from "../http.js";
import { assertAck } from "../http.js";
import type { OkResponse } from "./inference.js";
import type { FlagReason, FlagStatus, LabelReasonCode } from "./shared.js";

export type Label = "fraud" | "legitimate";

export interface LabelRequest {
  account_id: string;
  label: Label;
  /** Free text for reviewers. Never sent to a model. */
  notes?: string;
  /**
   * Idempotency key. A repeat writes nothing and returns `duplicate: true`.
   * Also what makes an SDK-level retry safe: labels are retried only when
   * this is set.
   */
  event_id?: string;
  /**
   * The flag this label settles, `flg_<n>` (a bare number works too).
   * Without it, `legitimate` dismisses whichever flag is open when the label
   * arrives and `fraud` confirms it; send the id your team reviewed so the
   * label cannot land on a newer flag. Not one of this account's flags: 404.
   */
  flag_id?: string;
  /** Why you labelled it. An open set. */
  reason_code?: LabelReasonCode;
  /**
   * Only with `legitimate`: the flag reasons you checked. Defaults to all of
   * them. Reasons you leave out stay open. Naming one the flag doesn't have
   * is a 400.
   */
  cleared_reasons?: FlagReason[];
}

/** What a label did to a flag. */
export interface FlagAdjudication {
  id: string;
  status: FlagStatus;
  cleared_reasons: FlagReason[];
  /** Still open. Empty after a full dismissal. */
  remaining_reasons: FlagReason[];
  /**
   * For each cleared reason, the RFC 3339 time it may raise a flag again. A
   * reason that is never silenced has no entry.
   */
  suppressed_until: Record<string, string>;
  /** True when this label reverses an earlier verdict on the same flag. */
  overturned?: boolean;
}

export interface LabelResponse extends OkResponse {
  /** Present when the label settled a flag. */
  flag?: FlagAdjudication;
}

/** Extra label fields for the `fraud()` / `legitimate()` shorthands. */
export type LabelOptions = Omit<LabelRequest, "account_id" | "label" | "notes">;

export class Labels {
  constructor(private readonly transport: Transport) {}

  /**
   * Report a verdict you reached yourself — a chargeback, a ban, a support
   * resolution. Label legitimate accounts too: a corpus of only-fraud labels
   * teaches a model nothing about the boundary.
   *
   * If the account has an open flag, the label also settles it.
   */
  submit(req: LabelRequest): Promise<LabelResponse> {
    return this.transport
      .post<LabelResponse>("/v1/labels", req, {
        idempotent: req.event_id !== undefined,
      })
      .then(assertAck);
  }

  fraud(accountId: string, notes?: string, opts: LabelOptions = {}): Promise<LabelResponse> {
    return this.submit({
      ...opts,
      account_id: accountId,
      label: "fraud",
      ...(notes !== undefined ? { notes } : {}),
    });
  }

  legitimate(
    accountId: string,
    notes?: string,
    opts: LabelOptions = {},
  ): Promise<LabelResponse> {
    return this.submit({
      ...opts,
      account_id: accountId,
      label: "legitimate",
      ...(notes !== undefined ? { notes } : {}),
    });
  }
}
