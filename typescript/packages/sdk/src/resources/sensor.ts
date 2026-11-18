// POST /v1/sensor/verify — check a browser sensor token from your server.
//
// The sensor itself is the CDN script that posts to `/v1/sensor/collect`; it
// is not part of this package or of `@vectoral-labs/browser`.

import type { Transport } from "../http.js";
import type { SensorDecision } from "./shared.js";

export interface SensorVerifyRequest {
  /** The token your page got from the browser sensor. */
  token: string;
  /**
   * The action you expect the token to have been minted for, such as
   * `signup`. When you send it, a token minted for a different action is
   * refused with a 400 (`token action mismatch`), so a token from your login
   * page cannot be replayed at signup. Omit it to accept any action.
   *
   * Servers that predate this check accept the field and ignore it.
   */
  action?: string;
}

export interface SensorVerifyResponse {
  /** True only when `decision` is `deny`. */
  is_bot: boolean;
  /** True only when `decision` is `allow`. A `challenge` is neither. */
  is_human: boolean;
  /** The browser session's bot score. */
  score: number;
  /** An open set. */
  decision: SensorDecision;
  /** Browser reasons behind the verdict, such as `webdriver_present`. */
  reasons: string[];
}

export class Sensor {
  constructor(private readonly transport: Transport) {}

  /**
   * Verify a sensor token and return the browser verdict.
   *
   * Throws a `VectoralError` with status 400 when the token is missing,
   * expired or invalid, or (when you pass `action`) minted for another
   * action; 403 when it belongs to another organisation. Branch on the
   * status, not the message. A verification writes nothing, so a transient
   * failure is retried.
   *
   * If all you want is the verdict folded into a score, pass the token as
   * `request.sensor_token` on `inference.score()` instead.
   */
  async verify(req: SensorVerifyRequest): Promise<SensorVerifyResponse> {
    const body = await this.transport.post<SensorVerifyResponse>(
      "/v1/sensor/verify",
      req,
      { idempotent: true },
    );
    // Go marshals a nil slice as `null`.
    return body.reasons === null ? { ...body, reasons: [] } : body;
  }
}
