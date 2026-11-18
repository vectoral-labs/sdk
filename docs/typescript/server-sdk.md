# `@vectoral-labs/sdk` reference

Server-side only. It holds a secret API key, and the client IP it sends is only
meaningful when your own server observed it.

```ts
import { Vectoral, RegistrationTier, VectoralError } from "@vectoral-labs/sdk";
const vectoral = new Vectoral({ apiKey: process.env.VECTORAL_API_KEY });
```

## `new Vectoral(options)`

| Option | Default | Notes |
| --- | --- | --- |
| `apiKey` | `VECTORAL_API_KEY` | Sent as `Authorization: Bearer` |
| `customerId` | — | `X-Customer-ID` header auth, for self-host. Mutually exclusive with `apiKey` |
| `baseUrl` | `VECTORAL_BASE_URL`, then the hosted `https://api.vectoral.cloud` | Trailing slashes stripped. Set it to your deployment's endpoint when that is not the hosted default |
| `timeoutMs` | `5000` | Per request |
| `retries` | `2` | **Writes: only applied to calls carrying an `event_id`.** Reads are always retried; `inference.score()` never is |
| `failOpen` | `true` | Scoring calls degrade instead of throwing |
| `fetch` | global `fetch` | Any `(url, init) => Promise<Response>` |
| `headers` | `{}` | Merged into every request |
| `fingerprint` | off | Prompt fingerprinting; see [salts](../concepts/salts.md) |
| `onError` | none | `(err, context)` for every fail-open failure. Wire this up |
| `onWarning` | `console.warn` | Non-fatal configuration problems |

Throws `VectoralConfigError` for a missing credential, both credentials, no
`fetch`, or `fingerprint.shareGlobal` without `enabled`. Everything else about
fingerprint configuration warns and disables rather than throwing.

`vectoral.fingerprintingActive` reports whether prompt fingerprinting resolved to
a usable salt.

## `vectoral.registrations`

### `.score(request) → Promise<RegistrationVerdict>`

Screen a signup before creating the account.

```ts
const verdict = await vectoral.registrations.score({
  email: "john.smith@acmecorp.co.uk",
  event_id: pendingSignup.id,      // idempotency; also enables retries
  ip: req.ip,                      // the IP YOUR server observed
  user_agent: req.headers["user-agent"],
  device_fingerprint: signals.device_fingerprint,
  client: signals.client,
  form: signals.form,
  deadline_ms: 600,
});

if (verdict.tier >= RegistrationTier.StepUp) return requireStepUp();
if (verdict.tier >= RegistrationTier.Challenge) return showCaptcha();
```

With the Action Policy on, branch on `action` instead:

```ts
switch (verdict.action) {
  case "block":     return refuse();
  case "review":    return holdForReview(verdict.registration_id);
  case "step_up":   return requireStepUp(verdict.registration_id); // then reportStepUp()
  case "challenge": return showCaptcha();
  default:          return allow();   // "allow", absent, or a value this SDK doesn't know
}
```

**Request**: `email` is the only required field. Also accepts `ip_hash`, `asn`,
`ip_country`, `declared_country`, `sensor_token`, `phone`, `username`,
`referrer`, and `identity` (name, date of birth, nationality, address) for
sanctions screening. See [registration screening](../concepts/registration-screening.md)
for what each is worth.

**Verdict**

| Field | Notes |
| --- | --- |
| `registration_id` | Pass to `identity.linkRegistration()`. `null` when `degraded` |
| `tier` | Open ordered scale. **Compare, never switch** |
| `score` | `[0,1]`. For logging, and for policy layered *on top of* `tier` — **`tier` is not determined by score alone and cannot be recomputed from it** ([why](../concepts/registration-screening.md#score-is-not-the-tier-and-you-cannot-recompute-one-from-the-other)) |
| `reasons` | Up to three, most significant first. Never `null` — `[]` instead |
| `duplicate` | True on an idempotent replay |
| `shadow_mode` | True in shadow mode. Without the Action Policy `tier` is then pinned to `0`; with it the real tier comes back and `action` is `allow` |
| `action` | Action Policy only. `allow`, `challenge`, `step_up`, `review` or `block`. Open set: treat unknown as `allow` |
| `action_reason` | Why. Open set (`score_threshold`, `shadow`, `policy_floor`, `domain_rule`, `sanctions_match`, …) |
| `policy_action` | In shadow mode, what the policy would have done |
| `step_up_fails` | Next to a `step_up`: your "When step-up fails" setting, `review` or `block` |
| `screening` | Sanctions screening. `{ status: "not_screened" }` unless you opted in. Absent when `degraded` |
| `degraded_facts` | The API's `degraded` list: facts whose lookups Vectoral owns failed. Renamed because `degraded` below already has a meaning |
| `degraded` | **True when this is the SDK's fail-open default, not a real answer** |
| `error` | The underlying `VectoralError`, when `degraded` |

Every other field the API sends is passed through as well.

`RegistrationTier` exports `Allow: 0`, `Challenge: 1`, `StepUp: 2` as named
constants for comparison. It is not an exhaustive enum.

### After scoring

None of these fail open. They throw `VectoralError` like any other call.

| Method | Endpoint | Notes |
| --- | --- | --- |
| `.get(id)` | `GET /v1/registrations/{id}` | The stored verdict, for a decision made later. `action` is as stored now (a failed step-up moves it); `step_up_result` and `review_decision` say what happened. Retried |
| `.reportStepUp(id, { passed })` | `POST …/step-up` | Returns the action now stored. `409` if the signup wasn't told `step_up` or a result is already in. Not retried |
| `.label(id, { label, notes? })` | `POST …/label` | Labels a signup, including one that never became an account. Not retried |
| `.getScreening(id)` | `GET …/screening` | The screening audit record. `input` is personal data. `404` when screening is off or never ran |
| `.createClearance(id, { entry_uid, note })` | `POST …/screening/clearances` | Clears a sanctions match as a false positive. Not retried |
| `.revokeClearance(id, entryUid)` | `DELETE …/screening/clearances/{entry_uid}` | `revoked: false` when there was nothing to revoke |

```ts
const result = await vectoral.registrations.reportStepUp(registrationId, { passed: false });
result.action; // "review" or "block", from your policy
```

## `vectoral.inference`

### `.score(request) → Promise<ScoreResponse>`

```ts
const verdict = await vectoral.inference.score({
  account_id: "user_abc123",
  session_id: sessionId,
  account: { first_seen: "2026-01-04T10:00:00Z", subscription_tier: "free" },
  request: {
    ip: req.ip,
    model_requested: "claude-opus-5",
    estimated_prompt_tokens: 1200,
    session_signals: { ms_since_last_request: 4200, interaction_events_count: 7 },
    prompt_text_to_fingerprint: userPrompt,   // local only; never sent
  },
});
```

Returns `score`, `tier` (`"low" | "medium" | "high"` — medium at `>=0.30`,
high at `>=0.60`, and note the tier is not a pure function of the score:
automated traffic is lifted to at least medium whatever it scored), `reasons`,
`baseline_ready`, `shadow_mode`, `deep_mode_active`, `blocked`, and on a fail-open failure
`degraded: true`.

With the Action Policy on, it also returns `action` (`allow` or `block`; treat
an unknown value as `allow`), `action_reason` and, in shadow mode,
`policy_action`. With account flags on, `account` carries the flag state:
`flag_level`, `flag_reasons`, `flag_id`, `flag_since` and `flag_set_by`. It
lags the call that raised the flag by a few seconds, and a flag never blocks
anything by itself.

`request` also takes `asn` and `ip_country`, your own lookups, stored for
investigation.

`request.prompt_text_to_fingerprint` is **always stripped from the wire**, with
or without fingerprinting configured, and your request object is never mutated.

### `.postCall(event) → Promise<OkResponse>`

```ts
await vectoral.inference.postCall({
  account_id: "user_abc123",
  session_id: sessionId,
  model: "claude-opus-5",
  prompt_tokens: usage.input_tokens,
  completion_tokens: usage.output_tokens,
  latency_ms: elapsed,
  event_id: requestId,        // makes a retry safe
});
```

**Never fails open** — handle or queue its errors. Omit `inference_cost_usd`
and the server computes cost from its own rate table, but only when a token
count is present and non-zero. Omit all three and a cost of `0` is recorded,
which reads as zero-value evidence — send a token count or an explicit cost.

Token counts have three states, not two. Omitted means "not measured"; `0` is
real evidence, and a zero completion count is a tell for synthetic traffic. Do
not coalesce a missing count to zero — for a modality that produces no
completion (embeddings, tts, stt, rerank) that asserts a fraud signal. Omit the
field instead.

## `vectoral.identity`

### `.record(event) → Promise<OkResponse>`

Signup, login, and dashboard events. Low-volume by design: dedupe on your side,
e.g. once per session per IP.

```ts
await vectoral.identity.record({
  account_id: "user_abc123",
  event_type: "login",
  ip: req.ip,
  event_id: `login-${sessionId}`,
});
```

### `.linkRegistration(accountId, registrationId, extra?) → Promise<OkResponse>`

Shorthand for the `signup` event that connects a registration to the account it
became. Safe to send late — see
[registration screening](../concepts/registration-screening.md#linking-the-account-back).

## `vectoral.labels`

```ts
await vectoral.labels.fraud("user_abc123", "chargeback 2026-09-14");
await vectoral.labels.legitimate("user_def456");
await vectoral.labels.submit({ account_id: "user_1", label: "fraud" });
```

Label legitimate accounts too — a fraud-only corpus teaches a model nothing
about the boundary.

A label also settles the account's open flag: `legitimate` dismisses it and
`fraud` confirms it. Send the `flag_id` your team reviewed so the label can't
land on a newer flag, and `cleared_reasons` to dismiss only some of its reasons.
The response's `flag` says what happened.

```ts
const { flag } = await vectoral.labels.legitimate("user_abc123", "nightly job", {
  flag_id: "flg_1234",
  reason_code: "batch_job",
  event_id: `review-${reviewId}`,   // makes the label retryable
});
flag?.status;            // "dismissed"
flag?.suppressed_until;  // when each cleared reason may flag again
```

Labels are retried only when they carry an `event_id`.

## `vectoral.sensor`

### `.verify({ token, action? }) → Promise<SensorVerifyResponse>`

Checks a browser sensor token from your server and returns `decision`
(`allow`, `challenge`, `deny`), `score`, `is_bot`, `is_human` and `reasons`.
Pass `action` to require the token was minted for that action. A server that
checks it answers a mismatch with `400` (`token action mismatch`); older ones
ignore the field. Other `400`s mean the token is missing, expired or invalid,
and `403` means it belongs to another organisation. Branch on `err.status`.

If you only want the browser verdict folded into a score, pass the token as
`request.sensor_token` on `inference.score()` instead.

## `vectoral.flags`

```ts
const page = await vectoral.flags.list({ status: "open", level: "flagged" });
for await (const flag of vectoral.flags.iterate({ status: "open" })) { /* every page */ }
const flag = await vectoral.flags.get("flg_1234");
```

Filters are checked strictly, so a typo is a `400`. Every value a flag carries
(`status`, `level`, `reasons`, `source`, `reraise_cause`) is an open set.

## `vectoral.accounts`

| Method | Endpoint |
| --- | --- |
| `.list(params?)` | `GET /v1/accounts`: `limit`, `offset`, `sort`, `order`, `label`, `tier`, `min_score`, `flag_level`, `window` |
| `.get(id, { window? })` | `GET /v1/accounts/{id}`: latest score, linked `registration`, usage `window`, `model_mix`, open `flag` |
| `.scores(id, { limit?, offset? })` | `GET /v1/accounts/{id}/scores` |
| `.setContext(id, context)` | `POST /v1/accounts/{id}/context`. Merged with what's stored. Not retried |
| `.recordCommerce(id, event)` | `POST /v1/accounts/{id}/commerce`. `event_id` is required, so it is retried. Hash the instrument yourself |
| `.stats()` | `GET /v1/stats` |

## `vectoral.imports` and `vectoral.data`

```ts
const result = await vectoral.imports.send({ import_id: "csv-2026-05", events });
result.rejected;                                // per-event rejections don't fail the batch
await vectoral.imports.get("csv-2026-05");      // totals across every batch
await vectoral.data.status();                   // imported history and its signal coverage
await vectoral.data.integrationStatus({ window: "7d" }); // which signals live traffic carries
```

Every import event needs an `event_id`, so a batch is retried on a transient
failure and a repeat reports `duplicate`. Its timeout is at least 30 seconds.

A `score` event goes through the same preparation as `inference.score()`:
`request.prompt_text_to_fingerprint` is stripped, and becomes a
`prompt_fingerprint` under your live salt when fingerprinting is on, so imported
and live fingerprints can match. An imported row reads back with `score: 0` and
`tier: ""` until it is scored (`StoredTier` in the read types); that `0` means
"not scored".

## Webhooks

```ts
import { parseWebhook, isWebhookEvent, WebhookVerificationError } from "@vectoral-labs/sdk";

app.post("/hooks/vectoral", express.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try {
    event = await parseWebhook({
      payload: req.body,                              // the raw bytes, not parsed JSON
      header: req.get("x-vectoral-signature"),
      secret: process.env.VECTORAL_WEBHOOK_SECRET!,   // whsec_…
    });
  } catch (err) {
    if (err instanceof WebhookVerificationError) return res.sendStatus(400);
    throw err;
  }
  if (isWebhookEvent(event, "account.flagged")) await openCase(event.data.flag_id);
  res.sendStatus(200); // acknowledge every event, including types you don't handle
});
```

`verifyWebhookSignature()` checks without parsing. Both reject with a `reason`
of `malformed`, `stale` (more than 5 minutes off your clock; change it with
`toleranceSeconds`) or `mismatch`. Verify the body exactly as it arrived: JSON
that was parsed and re-serialised will not match. During a secret rotation a
request carries a signature for each secret and either one verifies.
`signWebhookPayload()` produces a header the same way Vectoral does, for testing
your receiver.

Deliveries are at least once. Deduplicate on the envelope's `id`.

## Open value sets

Most string values the API returns can gain new members without a new API
version: `action`, `action_reason`, reasons, flag levels and reasons, screening
status, sensor decisions, webhook event types. The SDK passes an unknown value
through unchanged and never throws on one. The types list the known values for
autocomplete and also accept any string, so code like the `switch` above
compiles against a newer API. Always keep a default branch, and give it the
safest behaviour you handle: `allow` for `action`, and "acknowledge and ignore"
for a webhook type.

## Errors

```ts
import { VectoralError, VectoralConfigError } from "@vectoral-labs/sdk";

try {
  await vectoral.inference.postCall(event);
} catch (err) {
  if (err instanceof VectoralError) {
    err.code;          // "http_error" | "network_error" | "timeout" | "invalid_response"
    err.status;        // HTTP status, or 0 for network/timeout
    err.transient;     // network / timeout / 5xx — safe to retry WITH an event_id
    err.responseBody;  // raw body, when there was one
  }
}
```

`VectoralConfigError` is thrown at construction time only, never at call time.

## Salt helpers

```ts
import { generateSalt, suggestSaltId } from "@vectoral-labs/sdk";
```

`generateSalt()` returns 32 random bytes as hex. `suggestSaltId()` returns
`s_YYYY_MM`. Both are for bootstrapping and rotation — call them in a one-off
script, never at process start. See [salts](../concepts/salts.md).

## Low-level fingerprinting

```ts
import { computeFingerprint, conversationKey } from "@vectoral-labs/sdk";
```

Exported for integrations that precompute fingerprints (a proxy, a batch
importer) and attach `request.prompt_fingerprint` themselves. Most callers
should use `prompt_text_to_fingerprint` and let the SDK do it.
