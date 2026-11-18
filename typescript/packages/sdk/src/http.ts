import { VectoralError } from "./errors.js";

/** Minimal fetch signature so this runs on Node 20+, Deno, Bun, and edge runtimes. */
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

/**
 * Assert that a 2xx body is the acknowledgement these write endpoints promise.
 *
 * They never fail open, so an unvalidated pass-through is a silently dropped
 * write: a captive portal or version-skewed gateway answering `200 {"message":
 * "ok"}` would look exactly like delivered telemetry. Telemetry you silently
 * drop is telemetry you never notice missing.
 */
export function assertAck<T>(body: T): T {
  // Strictly `true`. `{ ok: false }` is not a success, and callers treat
  // fulfilment as delivery — they only retry on rejection — so resolving a
  // negative acknowledgement drops the write just as silently as accepting a
  // body with no `ok` at all.
  if ((body as { ok?: unknown })?.ok !== true) {
    throw new VectoralError(
      "vectoral: write was not acknowledged (expected `ok: true`)",
      { code: "invalid_response", status: 200, responseBody: JSON.stringify(body) },
    );
  }
  return body;
}

export interface PostOptions {
  /**
   * Whether a retry is safe. Every Vectoral write endpoint mints a new row per
   * call unless the body carries an `event_id`, so the transport refuses to
   * retry anything without one: a blind retry after a response lost in transit
   * would double-write.
   */
  idempotent: boolean;
  /**
   * A per-call timeout FLOOR, used by `deadline_ms`. It can only raise the
   * effective timeout, never lower it: a caller who configured `timeoutMs`
   * explicitly must not have it silently reduced by asking the server for a
   * tight budget, or a slow link turns every good verdict into a fail-open
   * zero — the failure mode `httpTimeoutFor` exists to prevent.
   */
  timeoutMs?: number;
}

type HttpMethod = "GET" | "POST" | "DELETE";

/** Query parameters. `undefined` values are left out of the URL. */
export type QueryParams = Record<string, string | number | boolean | undefined>;

function queryString(query: QueryParams | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) params.append(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

/**
 * One path segment, escaped so an id can never reach another route. `.` and
 * `..` survive `encodeURIComponent` and a URL parser resolves them, so
 * `flags.get("..")` would otherwise read `/v1/` — refuse them, and the empty
 * id, which would hit the collection route instead of the item.
 */
export function seg(value: string): string {
  if (value === "" || value === "." || value === "..") {
    throw new TypeError(`vectoral: ${JSON.stringify(value)} is not a valid id`);
  }
  return encodeURIComponent(value);
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with a 5s cap. */
const backoffMs = (attempt: number): number => Math.min(200 * 2 ** attempt, 5000);

export class Transport {
  constructor(private readonly opts: TransportOptions) {}

  async post<T>(path: string, body: unknown, po: PostOptions): Promise<T> {
    return this.request<T>("POST", path, body, po);
  }

  /**
   * GET a resource. Reads change nothing server-side, so they are always
   * safe to retry on a transient failure.
   */
  get<T>(path: string, query?: QueryParams): Promise<T> {
    return this.request<T>("GET", `${path}${queryString(query)}`, undefined, {
      idempotent: true,
    });
  }

  /** DELETE a resource. Retried only when the caller marks it idempotent. */
  delete<T>(path: string, po: PostOptions): Promise<T> {
    return this.request<T>("DELETE", path, undefined, po);
  }

  private async request<T>(
    method: HttpMethod,
    path: string,
    body: unknown,
    po: PostOptions,
  ): Promise<T> {
    const url = `${this.opts.baseUrl}${path}`;
    const maxAttempts = po.idempotent ? this.opts.retries : 0;
    let attempt = 0;
    for (;;) {
      try {
        return await this.doRequest<T>(
          method,
          url,
          body,
          Math.max(po.timeoutMs ?? 0, this.opts.timeoutMs),
        );
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

  private async doRequest<T>(
    method: HttpMethod,
    url: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // The timer must stay armed until the BODY is consumed, not just until the
    // headers land. A server or proxy that sends headers and then stalls
    // mid-body would otherwise hang this call forever: no timeout, no retry,
    // and no fail-open verdict for a flow that is waiting on one.
    try {
      return await this.send<T>(method, url, body, controller, timeoutMs);
    } finally {
      clearTimeout(timer);
    }
  }

  private async send<T>(
    method: HttpMethod,
    url: string,
    body: unknown,
    controller: AbortController,
    timeoutMs: number,
  ): Promise<T> {
    const failed = (err: unknown): VectoralError =>
      controller.signal.aborted
        ? new VectoralError(`request timed out after ${timeoutMs}ms`, {
            code: "timeout",
            status: 0,
            cause: err,
          })
        : new VectoralError(
            `network error: ${err instanceof Error ? err.message : String(err)}`,
            { code: "network_error", status: 0, cause: err },
          );

    let res: Response;
    try {
      res = await this.opts.fetch(url, {
        method,
        headers: {
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...this.opts.authHeader,
          ...this.opts.headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      throw failed(err);
    }

    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      // Headers arrived, then the body stalled or the stream broke.
      throw failed(err);
    }

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
