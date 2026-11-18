// The 0.3.0 surface, against a real local HTTP server.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Vectoral, VectoralError } from "./index.js";
import type { ScoreResponse } from "./index.js";
import { httpTimeoutFor } from "./resources/registrations.js";
import { startMockServer, type MockServer } from "./test-support/mock-server.js";

let server: MockServer;
let v: Vectoral;

beforeEach(async () => {
  server = await startMockServer();
  v = new Vectoral({ apiKey: "vg_live_test", baseUrl: server.url, retries: 2 });
});

afterEach(async () => {
  await server.close();
});

const SCORE_OK = {
  score: 0.73,
  tier: "high",
  reasons: ["machine_paced"],
  deep_mode_active: false,
  baseline_ready: true,
  shadow_mode: false,
  blocked: false,
};

const REG_OK = {
  registration_id: "reg_k4x2",
  tier: 1,
  score: 0.61,
  reasons: ["fresh_domain", "device_reuse"],
  screening: { status: "not_screened" },
};

const only = (): (typeof server.requests)[number] => {
  expect(server.requests).toHaveLength(1);
  return server.requests[0]!;
};

describe("inference.score: Action Policy and account flags", () => {
  it("returns action, action_reason, policy_action and the account flag state", async () => {
    server.on("POST /v1/score", {
      body: {
        ...SCORE_OK,
        tier: "low",
        shadow_mode: true,
        action: "allow",
        action_reason: "shadow",
        policy_action: "block",
        account: {
          flag_level: "flagged",
          flag_reasons: ["usage_jump_new_origin"],
          flag_id: "flg_4711",
          flag_since: "2026-11-17T03:12:09Z",
          flag_set_by: "rule",
        },
      },
    });
    const out: ScoreResponse = await v.inference.score({ account_id: "u1", request: {} });
    expect(out.action).toBe("allow");
    expect(out.action_reason).toBe("shadow");
    expect(out.policy_action).toBe("block");
    expect(out.account).toEqual({
      flag_level: "flagged",
      flag_reasons: ["usage_jump_new_origin"],
      flag_id: "flg_4711",
      flag_since: "2026-11-17T03:12:09Z",
      flag_set_by: "rule",
    });
    expect(out.degraded).toBeUndefined();
  });

  it("passes unknown open-set values through instead of degrading", async () => {
    server.on("POST /v1/score", {
      body: {
        ...SCORE_OK,
        action: "throttle",
        action_reason: "a_reason_from_the_future",
        account: { flag_level: "critical", flag_reasons: ["brand_new_rule.3"], flag_set_by: "robot" },
      },
    });
    const out = await v.inference.score({ account_id: "u1", request: {} });
    expect(out.degraded).toBeUndefined();
    expect(out.action).toBe("throttle");
    expect(out.action_reason).toBe("a_reason_from_the_future");
    expect(out.account?.flag_level).toBe("critical");
  });

  it("sends request.asn and request.ip_country", async () => {
    server.on("POST /v1/score", { body: SCORE_OK });
    await v.inference.score({
      account_id: "u1",
      request: { ip_hash: "tok", asn: 64496, ip_country: "DE" },
    });
    expect(only().body).toMatchObject({ request: { ip_hash: "tok", asn: 64496, ip_country: "DE" } });
  });

  it("returns a replayed block as the server sent it", async () => {
    server.on("POST /v1/score", {
      body: {
        ...SCORE_OK,
        score: 1,
        reasons: ["account_blocked"],
        baseline_ready: false,
        blocked: true,
        duplicate: true,
        action: "block",
        action_reason: "enforcement",
      },
    });
    const out = await v.inference.score({ account_id: "u1", event_id: "e1", request: {} });
    expect(out).toMatchObject({ blocked: true, duplicate: true, action: "block" });
  });

  it("is still never retried, even with an event_id", async () => {
    server.on("POST /v1/score", [{ status: 503, body: { error: "busy" } }, { body: SCORE_OK }]);
    const out = await v.inference.score({ account_id: "u1", event_id: "e1", request: {} });
    expect(server.requests).toHaveLength(1);
    expect(out.degraded).toBe(true);
  });
});

describe("registrations.score: the full verdict", () => {
  it("keeps action, step_up_fails and screening, and moves the API's degraded list", async () => {
    const screening = {
      status: "hit",
      screening_id: "scr_k3j9a1",
      list_versions: [{ source: "ofac_sdn", version: "sv_a1b2c3", published_at: "2026-10-07T00:00:00Z" }],
      matches: [
        {
          source: "ofac_sdn",
          entry_uid: "12345",
          entry_type: "individual",
          name: "DOE, Jane",
          matched_alias: "Jane DOE",
          matched_on: ["name", "date_of_birth"],
          score: 0.93,
          programs: ["EXAMPLE-PROGRAM"],
          cleared: false,
        },
      ],
      embargo: { status: "clear" },
    };
    server.on("POST /v1/registrations/score", {
      body: {
        ...REG_OK,
        tier: 2,
        degraded: ["email_reputation"],
        screening,
        action: "step_up",
        action_reason: "score_threshold",
        step_up_fails: "review",
      },
    });
    const out = await v.registrations.score({ email: "a@example.com" });
    expect(out).toEqual({
      registration_id: "reg_k4x2",
      tier: 2,
      score: 0.61,
      reasons: ["fresh_domain", "device_reuse"],
      screening,
      action: "step_up",
      action_reason: "score_threshold",
      step_up_fails: "review",
      degraded_facts: ["email_reputation"],
      degraded: false,
    });
  });

  it("passes through policy_action and fields this SDK does not know yet", async () => {
    server.on("POST /v1/registrations/score", {
      body: {
        ...REG_OK,
        shadow_mode: true,
        action: "allow",
        action_reason: "shadow",
        policy_action: "quarantine",
        some_future_field: { x: 1 },
      },
    });
    const out = await v.registrations.score({ email: "a@example.com" });
    expect(out.degraded).toBe(false);
    expect(out.policy_action).toBe("quarantine");
    expect((out as unknown as Record<string, unknown>).some_future_field).toEqual({ x: 1 });
    expect(out).not.toHaveProperty("degraded_facts");
  });

  it("sends the identity block for sanctions screening", async () => {
    server.on("POST /v1/registrations/score", { body: REG_OK });
    await v.registrations.score({
      email: "a@example.com",
      identity: {
        full_name: "Jane Doe",
        date_of_birth: "1980-04",
        address: { country: "UA", region: "UA-43" },
      },
    });
    expect(only().body).toMatchObject({
      identity: { full_name: "Jane Doe", address: { region: "UA-43" } },
    });
  });

  it("fails open without inventing a screening result", async () => {
    server.on("POST /v1/registrations/score", { status: 500, body: { error: "boom" } });
    const out = await v.registrations.score({ email: "a@example.com" });
    expect(out.degraded).toBe(true);
    expect(out.screening).toBeUndefined();
    expect(out.action).toBeUndefined();
  });

  it("keeps the HTTP timeout above the server's work outside deadline_ms", () => {
    // Domain rules (<=250 ms) and the save (<=500 ms) run outside the budget.
    for (const ms of [250, 400, 6000]) expect(httpTimeoutFor(ms)).toBeGreaterThanOrEqual(ms + 750);
  });
});

describe("registrations: read back, step-up, label, screening", () => {
  it("get() reads a stored verdict and normalises null reasons", async () => {
    server.on("GET /v1/registrations/reg_1", {
      body: {
        registration_id: "reg_1",
        tier: 0,
        score: 0,
        reasons: null,
        algo_version: "2",
        shadow_mode: true,
        received_at: "2026-10-30T09:14:02Z",
        linked_account_id: null,
        linked_at: null,
      },
    });
    const out = await v.registrations.get("reg_1");
    expect(out.reasons).toEqual([]);
    expect(out.linked_account_id).toBeNull();
    const req = only();
    expect(req.method).toBe("GET");
    expect(req.body).toBeUndefined();
    expect(req.headers["content-type"]).toBeUndefined();
    expect(req.headers["authorization"]).toBe("Bearer vg_live_test");
  });

  it("get() returns the Action Policy fields as stored now", async () => {
    server.on("GET /v1/registrations/reg_1", {
      body: {
        ...REG_OK,
        registration_id: "reg_1",
        degraded: ["email_reputation"],
        algo_version: "2",
        shadow_mode: false,
        received_at: "2026-10-30T09:14:02Z",
        linked_account_id: "user_abc123",
        linked_at: "2026-10-30T09:19:41Z",
        action: "review",
        action_reason: "score_threshold",
        step_up_result: "failed",
        review_decision: "allow",
      },
    });
    const out = await v.registrations.get("reg_1");
    expect(out).toMatchObject({
      action: "review",
      step_up_result: "failed",
      review_decision: "allow",
      degraded: ["email_reputation"],
    });
  });

  it("get() escapes the id into one path segment", async () => {
    server.on("GET /v1/registrations/a/b?c", { body: { ...REG_OK, reasons: [] } });
    await v.registrations.get("a/b?c");
    expect(only().rawPath).toBe("/v1/registrations/a%2Fb%3Fc");
  });

  it("refuses an id that would resolve to another route", async () => {
    await expect(v.registrations.get("..")).rejects.toThrow(TypeError);
    await expect(v.flags.get("")).rejects.toThrow(TypeError);
    expect(server.requests).toHaveLength(0);
  });

  it("get() throws on 404 rather than failing open", async () => {
    server.on("GET /v1/registrations/nope", { status: 404, body: { error: "unknown registration" } });
    const err = await v.registrations.get("nope").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VectoralError);
    expect((err as VectoralError).status).toBe(404);
  });

  it("get() retries a transient failure, because a read is safe to repeat", async () => {
    server.on("GET /v1/registrations/reg_1", [
      { status: 503, body: { error: "registration read is unavailable" } },
      { body: { ...REG_OK, registration_id: "reg_1" } },
    ]);
    const out = await v.registrations.get("reg_1");
    expect(out.registration_id).toBe("reg_1");
    expect(server.requests).toHaveLength(2);
  });

  it("get() rejects a 2xx body that is not a registration", async () => {
    server.on("GET /v1/registrations/reg_1", { body: { message: "ok" } });
    await expect(v.registrations.get("reg_1")).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("reportStepUp() posts the result and returns the stored action", async () => {
    server.on("POST /v1/registrations/reg_1/step-up", {
      body: { registration_id: "reg_1", passed: false, action: "review" },
    });
    const out = await v.registrations.reportStepUp("reg_1", { passed: false });
    expect(out).toEqual({ registration_id: "reg_1", passed: false, action: "review" });
    expect(only().body).toEqual({ passed: false });
  });

  it("reportStepUp() surfaces a 409 and is never retried", async () => {
    server.on("POST /v1/registrations/reg_1/step-up", {
      status: 409,
      body: { error: "this signup was not asked to step up" },
    });
    await expect(v.registrations.reportStepUp("reg_1", { passed: true })).rejects.toMatchObject({
      status: 409,
    });
    server.on("POST /v1/registrations/reg_2/step-up", { status: 503, body: { error: "busy" } });
    await expect(v.registrations.reportStepUp("reg_2", { passed: true })).rejects.toMatchObject({
      status: 503,
    });
    expect(server.requests).toHaveLength(2);
  });

  it("label() labels a signup", async () => {
    server.on("POST /v1/registrations/reg_1/label", {
      body: {
        ok: true,
        registration_id: "reg_1",
        label: "fraud",
        submitted_at: "2026-09-22T10:14:02Z",
      },
    });
    const out = await v.registrations.label("reg_1", { label: "fraud", notes: "farm" });
    expect(out.submitted_at).toBe("2026-09-22T10:14:02Z");
    expect(only().body).toEqual({ label: "fraud", notes: "farm" });
  });

  it("getScreening() returns the audit record", async () => {
    server.on("GET /v1/registrations/reg_1/screening", {
      body: {
        status: "hit",
        screening_id: "scr_1",
        matches: [{ entry_uid: "12345", cleared: false }],
        embargo: { status: "clear" },
        screened_at: "2026-10-08T14:03:22Z",
        input: { email: "jane@example.com", location: { ip_country: "DE" } },
        input_warnings: [],
        options: { lists: ["ofac_sdn"], threshold: 0.88 },
        blocked: true,
        screener: "index/v1",
      },
    });
    const out = await v.registrations.getScreening("reg_1");
    expect(out.status).toBe("hit");
    expect(out.input?.location).toEqual({ ip_country: "DE" });
    expect(out.options?.threshold).toBe(0.88);
  });

  it("createClearance() and revokeClearance() round-trip", async () => {
    server.on("POST /v1/registrations/reg_1/screening/clearances", {
      body: {
        ok: true,
        clearance: { entry_uid: "12 345", source: "ofac_sdn", created_at: "2026-10-08T14:10:00Z" },
      },
    });
    server.on("DELETE /v1/registrations/reg_1/screening/clearances/12 345", {
      body: { ok: true, revoked: false },
    });
    const made = await v.registrations.createClearance("reg_1", {
      entry_uid: "12 345",
      note: "Different person.",
    });
    expect(made.clearance.source).toBe("ofac_sdn");
    const gone = await v.registrations.revokeClearance("reg_1", "12 345");
    expect(gone.revoked).toBe(false);
    expect(server.requests.map((r) => [r.method, r.rawPath])).toEqual([
      ["POST", "/v1/registrations/reg_1/screening/clearances"],
      ["DELETE", "/v1/registrations/reg_1/screening/clearances/12%20345"],
    ]);
    expect(server.requests[0]!.body).toEqual({ entry_uid: "12 345", note: "Different person." });
    expect(server.requests[1]!.body).toBeUndefined();
  });
});

describe("labels", () => {
  it("sends flag_id, reason_code and cleared_reasons, and returns the flag outcome", async () => {
    const flag = {
      id: "flg_1234",
      status: "dismissed",
      cleared_reasons: ["high_streak"],
      remaining_reasons: [],
      suppressed_until: { high_streak: "2026-12-15T09:44:24Z" },
    };
    server.on("POST /v1/labels", { body: { ok: true, flag } });
    const out = await v.labels.submit({
      account_id: "user_abc123",
      label: "legitimate",
      flag_id: "flg_1234",
      reason_code: "batch_job",
      cleared_reasons: ["high_streak"],
      notes: "nightly job",
    });
    expect(out.flag).toEqual(flag);
    expect(only().body).toEqual({
      account_id: "user_abc123",
      label: "legitimate",
      flag_id: "flg_1234",
      reason_code: "batch_job",
      cleared_reasons: ["high_streak"],
      notes: "nightly job",
    });
  });

  it("the shorthands take the new fields too", async () => {
    server.on("POST /v1/labels", { body: { ok: true } });
    await v.labels.legitimate("u1", undefined, { flag_id: "flg_9", event_id: "lbl-1" });
    expect(only().body).toEqual({
      account_id: "u1",
      label: "legitimate",
      flag_id: "flg_9",
      event_id: "lbl-1",
    });
  });

  it("retries only when an event_id makes the label idempotent", async () => {
    server.on("POST /v1/labels", [{ status: 503, body: { error: "busy" } }, { body: { ok: true } }]);
    await expect(v.labels.fraud("u1")).rejects.toMatchObject({ status: 503 });
    expect(server.requests).toHaveLength(1);

    server.on("POST /v1/labels", [{ status: 503, body: { error: "busy" } }, { body: { ok: true } }]);
    const out = await v.labels.submit({ account_id: "u1", label: "fraud", event_id: "lbl-2" });
    expect(out.ok).toBe(true);
    expect(server.requests).toHaveLength(3);
  });

  it("surfaces a 404 for a flag that isn't this account's", async () => {
    server.on("POST /v1/labels", { status: 404, body: { error: "flag not found for this account" } });
    await expect(
      v.labels.submit({ account_id: "u1", label: "fraud", flag_id: "flg_1" }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("sensor.verify", () => {
  const VERDICT = { is_bot: false, is_human: true, score: 0.08, decision: "allow", reasons: null };

  it("verifies a token and normalises null reasons", async () => {
    server.on("POST /v1/sensor/verify", { body: VERDICT });
    const out = await v.sensor.verify({ token: "tok", action: "signup" });
    expect(out).toEqual({ ...VERDICT, reasons: [] });
    expect(only().body).toEqual({ token: "tok", action: "signup" });
  });

  it("omits action when you don't pass it", async () => {
    server.on("POST /v1/sensor/verify", { body: VERDICT });
    await v.sensor.verify({ token: "tok" });
    expect(only().body).toEqual({ token: "tok" });
  });

  it("throws a 400 on an action mismatch", async () => {
    server.on("POST /v1/sensor/verify", { status: 400, body: { error: "token action mismatch" } });
    const err = await v.sensor.verify({ token: "tok", action: "login" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VectoralError);
    expect((err as VectoralError).status).toBe(400);
    expect((err as VectoralError).message).toBe("vectoral 400: token action mismatch");
    expect(server.requests).toHaveLength(1);
  });

  it("passes an unknown decision through", async () => {
    server.on("POST /v1/sensor/verify", { body: { ...VERDICT, decision: "inspect", reasons: [] } });
    expect((await v.sensor.verify({ token: "tok" })).decision).toBe("inspect");
  });

  it("retries a transient failure: a verification writes nothing", async () => {
    server.on("POST /v1/sensor/verify", [{ status: 502, body: { error: "bad gateway" } }, { body: VERDICT }]);
    await v.sensor.verify({ token: "tok" });
    expect(server.requests).toHaveLength(2);
  });
});

describe("flags", () => {
  const FLAG = {
    id: "flg_1234",
    account_id: "user_abc123",
    status: "open",
    level: "flagged",
    peak_level: "flagged",
    reasons: ["usage_jump_new_origin"],
    source: "rule",
    opened_at: "2026-11-16T09:09:57Z",
    closed_at: null,
    reraise_cause: null,
    previous_flag_id: "flg_1101",
  };

  it("list() sends the filters as query parameters", async () => {
    server.on("GET /v1/flags", { body: { flags: [FLAG], next_cursor: null } });
    const out = await v.flags.list({ status: "open", level: "flagged", limit: 10, since: "2026-11-01T00:00:00Z" });
    expect(out.flags[0]).toEqual(FLAG);
    expect(only().query).toEqual({
      status: "open",
      level: "flagged",
      limit: "10",
      since: "2026-11-01T00:00:00Z",
    });
  });

  it("iterate() follows next_cursor to the last page", async () => {
    server.on("GET /v1/flags", (req) =>
      req.query.cursor === "c2"
        ? { body: { flags: [{ ...FLAG, id: "flg_2" }], next_cursor: null } }
        : { body: { flags: [FLAG], next_cursor: "c2" } },
    );
    const ids: string[] = [];
    for await (const f of v.flags.iterate({ account_id: "user_abc123" })) ids.push(f.id);
    expect(ids).toEqual(["flg_1234", "flg_2"]);
    expect(server.requests.map((r) => r.query)).toEqual([
      { account_id: "user_abc123" },
      { account_id: "user_abc123", cursor: "c2" },
    ]);
  });

  it("get() reads one flag, unknown values and all", async () => {
    server.on("GET /v1/flags/flg_1234", {
      body: { ...FLAG, status: "escalated", reraise_cause: "something_new" },
    });
    const out = await v.flags.get("flg_1234");
    expect(out.status).toBe("escalated");
    expect(out.reraise_cause).toBe("something_new");
  });
});

describe("accounts", () => {
  it("list() sends filters and returns the page", async () => {
    server.on("GET /v1/accounts", {
      body: {
        accounts: [{ account_id: "user_abc123", latest_score: 0.81, flag_level: "flagged", flag_id: "flg_1" }],
        total: 1,
        limit: 50,
        offset: 0,
      },
    });
    const out = await v.accounts.list({ flag_level: "any", min_score: 0.7, sort: "score", window: "7d" });
    expect(out.total).toBe(1);
    expect(only().query).toEqual({ flag_level: "any", min_score: "0.7", sort: "score", window: "7d" });
  });

  it("get() returns the detail with registration and flag", async () => {
    server.on("GET /v1/accounts/user abc", {
      body: {
        account_id: "user abc",
        latest_score: { score: 0.81, tier: "high", reasons: null },
        registration: { registration_id: "reg_1", tier: 1, score: 0.6, reasons: null },
        window: { events: 1, prompt_tokens: 2, completion_tokens: 3, inference_cost_usd: 0.5 },
        model_mix: [],
        flag: null,
      },
    });
    const out = await v.accounts.get("user abc", { window: "1d" });
    expect(out.latest_score?.reasons).toEqual([]);
    expect(out.registration?.reasons).toEqual([]);
    expect(out.flag).toBeNull();
    expect(only().rawPath).toBe("/v1/accounts/user%20abc");
    expect(only().query).toEqual({ window: "1d" });
  });

  it("scores() pages the history", async () => {
    server.on("GET /v1/accounts/u1/scores", {
      body: { scores: [{ id: 1, score: 0.2, tier: "low", reasons: null }], total: 1, limit: 5, offset: 0 },
    });
    const out = await v.accounts.scores("u1", { limit: 5 });
    expect(out.scores[0]!.reasons).toEqual([]);
    expect(only().query).toEqual({ limit: "5" });
  });

  it("setContext() posts the context and is not retried", async () => {
    server.on("POST /v1/accounts/u1/context", [{ status: 503, body: { error: "busy" } }, { body: { ok: true } }]);
    await expect(v.accounts.setContext("u1", { plan_type: "paid" })).rejects.toMatchObject({ status: 503 });
    expect(only().body).toEqual({ plan_type: "paid" });
  });

  it("recordCommerce() is retried, because event_id is required", async () => {
    server.on("POST /v1/accounts/u1/commerce", [{ status: 500, body: { error: "x" } }, { body: { ok: true } }]);
    const event = {
      event_id: "evt_1",
      event_type: "funding_succeeded" as const,
      amount_usd: 25.5,
      instrument_hash: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    };
    await v.accounts.recordCommerce("u1", event);
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]!.body).toEqual(event);
  });

  it("stats() reads the organisation totals", async () => {
    server.on("GET /v1/stats", { body: { total_accounts: 1820, high_risk_accounts: 37 } });
    expect((await v.accounts.stats()).total_accounts).toBe(1820);
  });
});

describe("imports and data", () => {
  it("imports.send() posts a batch and is retried (every event has an event_id)", async () => {
    const result = {
      import_id: "csv-1",
      received: 1,
      accepted: 1,
      duplicate: 0,
      rejected: 0,
      results: [{ event_id: "evt-001", status: "accepted" }],
    };
    server.on("POST /v1/import", [{ status: 503, body: { error: "busy" } }, { body: result }]);
    const batch = {
      import_id: "csv-1",
      events: [
        {
          event_id: "evt-001",
          type: "label" as const,
          event_time: "2026-05-02T00:00:00Z",
          label: { account_id: "u1", label: "legitimate" as const },
        },
      ],
    };
    expect(await v.imports.send(batch)).toEqual(result);
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]!.body).toEqual(batch);
  });

  it("imports.send() never sends prompt_text_to_fingerprint", async () => {
    server.on("POST /v1/import", { body: { import_id: "x", received: 1, accepted: 1, duplicate: 0, rejected: 0, results: [] } });
    const batch = {
      events: [
        {
          event_id: "evt-1",
          type: "score" as const,
          event_time: "2026-05-01T09:12:00Z",
          score: { account_id: "u1", request: { ip: "192.0.2.1", prompt_text_to_fingerprint: "a secret prompt" } },
        },
      ],
    };
    await v.imports.send(batch);
    const sent = (only().body as { events: { score: { request: Record<string, unknown> } }[] }).events[0]!;
    expect(sent.score.request).toEqual({ ip: "192.0.2.1" });
    // The caller's batch is untouched.
    expect(batch.events[0]!.score.request.prompt_text_to_fingerprint).toBe("a secret prompt");
  });

  it("imports.send() fingerprints imported prompts with the live salt", async () => {
    const fv = new Vectoral({
      apiKey: "k",
      baseUrl: server.url,
      fingerprint: { enabled: true, salt: "0".repeat(32) + "abcdef", saltId: "s_2026_09" },
    });
    server.on("POST /v1/import", { body: { import_id: "x", received: 1, accepted: 1, duplicate: 0, rejected: 0, results: [] } });
    await fv.imports.send({
      events: [
        {
          event_id: "evt-1",
          type: "score",
          event_time: "2026-05-01T09:12:00Z",
          score: {
            account_id: "u1",
            request: { prompt_text_to_fingerprint: "summarise this quarterly report for the board in five bullet points please" },
          },
        },
        { event_id: "evt-2", type: "label", event_time: "2026-05-01T09:12:00Z", label: { account_id: "u1", label: "fraud" } },
      ],
    });
    const events = (only().body as { events: Record<string, any>[] }).events;
    expect(events[0]!.score.request).not.toHaveProperty("prompt_text_to_fingerprint");
    expect(events[0]!.score.request.prompt_fingerprint).toMatchObject({ v: 1, salt_id: "s_2026_09" });
    expect(events[1]).toEqual({ event_id: "evt-2", type: "label", event_time: "2026-05-01T09:12:00Z", label: { account_id: "u1", label: "fraud" } });
  });

  it("score history types allow the empty tier of an unscored import", async () => {
    server.on("GET /v1/accounts/u1/scores", {
      body: { scores: [{ id: 1, score: 0, tier: "", reasons: null }], total: 1, limit: 50, offset: 0 },
    });
    const row = (await v.accounts.scores("u1")).scores[0]!;
    const unscored: boolean = row.tier === "";
    expect(unscored).toBe(true);
  });

  it("imports.get() reads combined status", async () => {
    server.on("GET /v1/import/csv-export-2026-05", {
      body: { import_id: "csv-export-2026-05", received: 812, rejections: [], rejections_truncated: false },
    });
    expect((await v.imports.get("csv-export-2026-05")).received).toBe(812);
  });

  it("data.status() and data.integrationStatus() read the reports", async () => {
    server.on("GET /v1/data/status", { body: { rows: 812403, estimated: false } });
    server.on("GET /v1/integration/status", {
      body: { window: "24h", estimated: false, detections_unavailable: [], payloads: [] },
    });
    expect((await v.data.status()).rows).toBe(812403);
    expect((await v.data.integrationStatus({ window: "24h" })).window).toBe("24h");
    expect(server.requests[1]!.query).toEqual({ window: "24h" });
  });
});
