import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Vectoral, VectoralConfigError, VectoralError, RegistrationTier } from "./index.js";

interface Call {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** A fetch stub that records calls and replays a queue of responses. */
function stubFetch(
  responses: (Response | Error)[],
): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({
      url,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (next instanceof Error) throw next;
    return next!;
  };
  return { fetch: fetchImpl as unknown as typeof fetch, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const REG_OK = {
  registration_id: "reg_abc",
  tier: 1,
  score: 0.61,
  reasons: ["fresh_domain"],
};

describe("construction", () => {
  const saved = process.env.VECTORAL_API_KEY;
  beforeEach(() => {
    delete process.env.VECTORAL_API_KEY;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.VECTORAL_API_KEY;
    else process.env.VECTORAL_API_KEY = saved;
  });

  it("requires a credential", () => {
    expect(() => new Vectoral({})).toThrow(VectoralConfigError);
  });

  it("rejects both credentials at once", () => {
    expect(() => new Vectoral({ apiKey: "k", customerId: "c" })).toThrow(
      /not both/,
    );
  });

  it("reads the API key from the environment", async () => {
    process.env.VECTORAL_API_KEY = "vg_live_env";
    const { fetch, calls } = stubFetch([json(REG_OK)]);
    const v = new Vectoral({ fetch });
    await v.registrations.score({ email: "a@example.com" });
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer vg_live_env");
  });

  it("uses header auth for a self-hosted deployment", async () => {
    const { fetch, calls } = stubFetch([json(REG_OK)]);
    const v = new Vectoral({ customerId: "cust_1", fetch });
    await v.registrations.score({ email: "a@example.com" });
    expect(calls[0]!.headers["X-Customer-ID"]).toBe("cust_1");
    expect(calls[0]!.headers["Authorization"]).toBeUndefined();
  });

  it("strips a trailing slash from baseUrl", async () => {
    const { fetch, calls } = stubFetch([json(REG_OK)]);
    const v = new Vectoral({ apiKey: "k", baseUrl: "http://localhost:8080/", fetch });
    await v.registrations.score({ email: "a@example.com" });
    expect(calls[0]!.url).toBe("http://localhost:8080/v1/registrations/score");
  });
});

describe("registrations.score", () => {
  it("returns the verdict and normalizes null reasons", async () => {
    const { fetch } = stubFetch([
      json({ registration_id: "reg_1", tier: 0, score: 0.1, reasons: null }),
    ]);
    const v = new Vectoral({ apiKey: "k", fetch });
    const out = await v.registrations.score({ email: "a@example.com" });
    expect(out).toMatchObject({
      registration_id: "reg_1",
      tier: RegistrationTier.Allow,
      reasons: [],
      degraded: false,
    });
  });

  it("fails open to tier 0 on a network error", async () => {
    const onError = vi.fn();
    const { fetch } = stubFetch([new TypeError("connection refused")]);
    const v = new Vectoral({ apiKey: "k", fetch, onError });
    const out = await v.registrations.score({ email: "a@example.com" });
    expect(out.tier).toBe(RegistrationTier.Allow);
    expect(out.degraded).toBe(true);
    expect(out.registration_id).toBeNull();
    expect(out.error).toBeInstanceOf(VectoralError);
    expect(onError).toHaveBeenCalledWith(expect.any(VectoralError), "registrations.score");
  });

  it("fails open on a 5xx too", async () => {
    const { fetch } = stubFetch([json({ error: "boom" }, 503)]);
    const v = new Vectoral({ apiKey: "k", fetch, retries: 0 });
    const out = await v.registrations.score({ email: "a@example.com" });
    expect(out.degraded).toBe(true);
  });

  it("throws instead when failOpen is off", async () => {
    const { fetch } = stubFetch([json({ error: "bad email" }, 400)]);
    const v = new Vectoral({ apiKey: "k", fetch, failOpen: false });
    await expect(v.registrations.score({ email: "nope" })).rejects.toThrow(
      /vectoral 400: bad email/,
    );
  });
});

describe("retry policy", () => {
  it("does not retry a call without an event_id", async () => {
    const { fetch, calls } = stubFetch([new TypeError("down")]);
    const v = new Vectoral({ apiKey: "k", fetch, retries: 3 });
    await v.registrations.score({ email: "a@example.com" });
    expect(calls).toHaveLength(1);
  });

  it("retries a transient failure when an event_id makes it idempotent", async () => {
    const { fetch, calls } = stubFetch([
      new TypeError("down"),
      new TypeError("down"),
      json(REG_OK),
    ]);
    const v = new Vectoral({ apiKey: "k", fetch, retries: 3 });
    const out = await v.registrations.score({
      email: "a@example.com",
      event_id: "signup-1",
    });
    expect(calls).toHaveLength(3);
    expect(out.degraded).toBe(false);
    expect(out.registration_id).toBe("reg_abc");
  }, 20_000);

  it("never retries a 4xx", async () => {
    const { fetch, calls } = stubFetch([json({ error: "bad" }, 400)]);
    const v = new Vectoral({ apiKey: "k", fetch, retries: 3, failOpen: false });
    await expect(
      v.registrations.score({ email: "x", event_id: "e1" }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});

describe("inference.score", () => {
  const SCORE_OK = {
    score: 0.2,
    tier: "low",
    reasons: [],
    deep_mode_active: false,
    baseline_ready: true,
    shadow_mode: false,
  };

  it("always strips prompt_text_to_fingerprint from the wire", async () => {
    const { fetch, calls } = stubFetch([json(SCORE_OK)]);
    const v = new Vectoral({ apiKey: "k", fetch });
    await v.inference.score({
      account_id: "u1",
      request: { prompt_text_to_fingerprint: "a secret the SDK must never send" },
    });
    const body = calls[0]!.body as { request: Record<string, unknown> };
    expect(body.request).not.toHaveProperty("prompt_text_to_fingerprint");
    expect(body.request).not.toHaveProperty("prompt_fingerprint");
  });

  it("does not mutate the caller's request object", async () => {
    const { fetch } = stubFetch([json(SCORE_OK)]);
    const v = new Vectoral({ apiKey: "k", fetch });
    const req = {
      account_id: "u1",
      request: { prompt_text_to_fingerprint: "keep me" },
    };
    await v.inference.score(req);
    expect(req.request.prompt_text_to_fingerprint).toBe("keep me");
  });

  it("attaches a fingerprint when a salt is configured", async () => {
    const { fetch, calls } = stubFetch([json(SCORE_OK)]);
    const v = new Vectoral({
      apiKey: "k",
      fetch,
      fingerprint: {
        enabled: true,
        salt: "0".repeat(32) + "abcdef",
        saltId: "s_2026_09",
      },
    });
    expect(v.fingerprintingActive).toBe(true);
    await v.inference.score({
      account_id: "u1",
      session_id: "sess_9",
      request: {
        prompt_text_to_fingerprint:
          "write me a long marketing email about discount sneakers for the autumn sale",
      },
    });
    const fp = (calls[0]!.body as { request: { prompt_fingerprint: Record<string, unknown> } })
      .request.prompt_fingerprint;
    expect(fp).toMatchObject({ v: 1, salt_id: "s_2026_09", conversation_key: "sess_9" });
    expect(fp["simhash"]).toMatch(/^[0-9a-f]{16}$/);
    expect(fp["band_keys"]).toHaveLength(16);
    expect(fp).not.toHaveProperty("simhash_global");
  });

  it("adds the global simhash only when shareGlobal is set", async () => {
    const { fetch, calls } = stubFetch([json(SCORE_OK)]);
    const v = new Vectoral({
      apiKey: "k",
      fetch,
      fingerprint: {
        enabled: true,
        shareGlobal: true,
        salt: "f".repeat(40),
        saltId: "s_2026_09",
      },
    });
    await v.inference.score({
      account_id: "u1",
      request: {
        prompt_text_to_fingerprint:
          "write me a long marketing email about discount sneakers for the autumn sale",
      },
    });
    const fp = (calls[0]!.body as { request: { prompt_fingerprint: Record<string, unknown> } })
      .request.prompt_fingerprint;
    expect(fp["simhash_global"]).toMatch(/^[0-9a-f]{16}$/);
  });

  it("sends no fingerprint for text under the token floor", async () => {
    const { fetch, calls } = stubFetch([json(SCORE_OK)]);
    const v = new Vectoral({
      apiKey: "k",
      fetch,
      fingerprint: { enabled: true, salt: "a".repeat(32), saltId: "s1" },
    });
    await v.inference.score({
      account_id: "u1",
      request: { prompt_text_to_fingerprint: "hi there" },
    });
    expect((calls[0]!.body as { request: object }).request).not.toHaveProperty(
      "prompt_fingerprint",
    );
  });

  it("fails open to a clean, degraded verdict", async () => {
    const { fetch } = stubFetch([new TypeError("down")]);
    const v = new Vectoral({ apiKey: "k", fetch });
    const out = await v.inference.score({ account_id: "u1", request: {} });
    expect(out).toMatchObject({ score: 0, tier: "low", degraded: true });
  });
});

describe("telemetry and labels", () => {
  it("postCall never fails open", async () => {
    const { fetch } = stubFetch([new TypeError("down")]);
    const v = new Vectoral({ apiKey: "k", fetch });
    await expect(
      v.inference.postCall({ account_id: "u1", prompt_tokens: 10, completion_tokens: 20 }),
    ).rejects.toThrow(VectoralError);
  });

  it("linkRegistration sends a signup identity event", async () => {
    const { fetch, calls } = stubFetch([json({ ok: true })]);
    const v = new Vectoral({ apiKey: "k", fetch });
    await v.identity.linkRegistration("user_1", "reg_abc", { ip: "203.0.113.7" });
    expect(calls[0]!.url).toMatch(/\/v1\/identity$/);
    expect(calls[0]!.body).toEqual({
      account_id: "user_1",
      event_type: "signup",
      registration_id: "reg_abc",
      ip: "203.0.113.7",
    });
  });

  it("labels.fraud omits notes when absent", async () => {
    const { fetch, calls } = stubFetch([json({ ok: true })]);
    const v = new Vectoral({ apiKey: "k", fetch });
    await v.labels.fraud("user_1");
    expect(calls[0]!.body).toEqual({ account_id: "user_1", label: "fraud" });
  });
});
