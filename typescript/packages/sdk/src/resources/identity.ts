// POST /v1/identity — low-volume, high-signal authentication events, and the
// place a registration gets linked to the account it became.

import type { Transport } from "../http.js";
import type { OkResponse } from "./inference.js";

export type IdentityEventType = "signup" | "login" | "dashboard";

export interface IdentityEvent {
  /** Created if not already present, so identity-only accounts still surface. */
  account_id: string;
  /** Defaults to `login` server-side. */
  event_type?: IdentityEventType;
  /** The user's real browser IP at that moment. */
  ip?: string;
  /** Your own keyed token instead of `ip`. */
  ip_hash?: string;
  asn?: number;
  ip_country?: string;
  user_agent?: string;
  /** Idempotency key. Also what makes an SDK-level retry safe. */
  event_id?: string;
  /**
   * The handle from `registrations.score()`. Send it once, on the `signup`
   * event, and the fraud labels you later report reach back to the registration
   * that produced the account. That is the feedback loop.
   *
   * It can arrive late — if you gate account creation on email verification,
   * store the id with your pending-signup record and send it whenever the
   * account is finally created. An unknown or already-linked id is ignored,
   * never rejected.
   */
  registration_id?: string;
}

export class Identity {
  constructor(private readonly transport: Transport) {}

  /**
   * Record an authentication event.
   *
   * Use the same IP shape here as on `inference.score()`: the accounts-per-IP
   * query unions both sources, so mixing raw addresses on one and tokens on the
   * other splits your own sybil graph.
   */
  record(event: IdentityEvent): Promise<OkResponse> {
    return this.transport.post<OkResponse>("/v1/identity", event, {
      idempotent: event.event_id !== undefined,
    });
  }

  /**
   * Convenience for the common signup case: record the event and link the
   * registration in one call.
   */
  linkRegistration(
    accountId: string,
    registrationId: string,
    extra: Omit<IdentityEvent, "account_id" | "registration_id" | "event_type"> = {},
  ): Promise<OkResponse> {
    return this.record({
      ...extra,
      account_id: accountId,
      event_type: "signup",
      registration_id: registrationId,
    });
  }
}
