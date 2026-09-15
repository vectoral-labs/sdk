import { VectoralError } from "./errors.js";

/** Minimal fetch signature so this runs on Node 18+, Deno, Bun, and edge runtimes. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface TransportOptions {
  baseUrl: string;
  authHeader: Record<string, string>;
  headers: Record<string, string>;
  timeoutMs: number;
  fetch: FetchLike;
  /**
   * Attempts after the first, for transient failures. Only applied to requests
   * the caller marked idempotent — see `post()`.
   */
  retries: number;
}

export interface PostOptions {
  /**
   * Whether a retry is safe. Every Vectoral write endpoint mints a new row per
   * call unless the body carries an `event_id`, so the transport refuses to
   * retry anything without one: a blind retry after a response lost in transit
   * would double-write.
   */
  idempotent: boolean;
  /** Overrides the client-wide timeout for this call (used by `deadline_ms`). */
  timeoutMs?: number;
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with a 5s cap. */
const backoffMs = (attempt: number): number => Math.min(200 * 2 ** attempt, 5000);

export class Transport {
  constructor(private readonly opts: TransportOptions) {}

  async post<T>(path: string, body: unknown, po: PostOptions): Promise<T> {
    const url = `${this.opts.baseUrl}${path}`;
    const maxAttempts = po.idempotent ? this.opts.retries : 0;
    let attempt = 0;
    for (;;) {
      try {
        return await this.doPost<T>(url, body, po.timeoutMs ?? this.opts.timeoutMs);
      } catch (err) {
        const retryable = err instanceof VectoralError && err.transient;
        if (retryable && attempt < maxAttempts) {
          attempt += 1;
          await delay(backoffMs(attempt));
          continue;
        }
        throw err;
      }
    }
  }

  private async doPost<T>(url: string, body: unknown, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await this.opts.fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.opts.authHeader,
          ...this.opts.headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new VectoralError(`request timed out after ${timeoutMs}ms`, {
          code: "timeout",
          status: 0,
          cause: err,
        });
      }
      throw new VectoralError(
        `network error: ${err instanceof Error ? err.message : String(err)}`,
        { code: "network_error", status: 0, cause: err },
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();

    if (!res.ok) {
      let message = res.statusText;
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        if (typeof parsed.error === "string") message = parsed.error;
      } catch {
        // non-JSON error body (e.g. a load balancer HTML page); keep statusText
      }
      throw new VectoralError(`vectoral ${res.status}: ${message}`, {
        code: "http_error",
        status: res.status,
        responseBody: text,
      });
    }

    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new VectoralError("vectoral: invalid JSON in response body", {
        code: "invalid_response",
        status: res.status,
        responseBody: text,
        cause: err,
      });
    }
  }
}
