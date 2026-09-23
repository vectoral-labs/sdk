/** Categorizes why a call failed, so callers can branch without string-matching. */
export type VectoralErrorCode =
  | "http_error"
  | "network_error"
  | "timeout"
  | "invalid_response";

/** Thrown for any non-2xx response, network failure, or timeout. */
export class VectoralError extends Error {
  /** HTTP status code, or 0 for network/timeout errors. */
  readonly status: number;
  readonly code: VectoralErrorCode;
  /** Raw response body, when there was one. */
  readonly responseBody: string | undefined;

  constructor(
    message: string,
    opts: {
      code: VectoralErrorCode;
      status: number;
      responseBody?: string;
      cause?: unknown;
    },
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "VectoralError";
    this.code = opts.code;
    this.status = opts.status;
    this.responseBody = opts.responseBody;
  }

  /**
   * True for failures where the request provably did not reach a decision:
   * network errors, timeouts, and 5xx. A retry is safe only if the call also
   * carried an `event_id` — see `docs/concepts/reliability.md`.
   */
  get transient(): boolean {
    return (
      this.code === "network_error" ||
      this.code === "timeout" ||
      (this.code === "http_error" && this.status >= 500)
    );
  }
}

/**
 * Invoke a caller-supplied error callback, swallowing anything it throws.
 *
 * `onError` runs on the fail-open path, so a logging or metrics handler that
 * blows up would otherwise convert the degraded verdict into a rejection —
 * taking down the very flow `failOpen` exists to protect. The failure is not
 * lost: the verdict still carries `degraded: true` and the underlying `error`.
 */
export function notifyError(
  cb: ((err: VectoralError, context: string) => void) | undefined,
  err: VectoralError,
  context: string,
): void {
  try {
    cb?.(err, context);
  } catch {
    // Deliberately empty — see above.
  }
}

/** Thrown at construction time for a misconfigured client. Never at call time. */
export class VectoralConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VectoralConfigError";
  }
}
