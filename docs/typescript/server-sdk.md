# `@vectoral/sdk` reference

Server-side only. It holds a secret API key, and the client IP it sends is only
meaningful when your own server observed it.

```ts
import { Vectoral, RegistrationTier, VectoralError } from "@vectoral/sdk";
const vectoral = new Vectoral({ apiKey: process.env.VECTORAL_API_KEY });
```

## `new Vectoral(options)`

| Option | Default | Notes |
| --- | --- | --- |
| `apiKey` | `VECTORAL_API_KEY` | Sent as `Authorization: Bearer` |
| `customerId` | — | `X-Customer-ID` header auth, for self-host. Mutually exclusive with `apiKey` |
| `baseUrl` | `VECTORAL_BASE_URL`, then `https://api.vectoral.cloud` | Trailing slashes stripped |
| `timeoutMs` | `5000` | Per request |
| `retries` | `2` | **Only applied to calls carrying an `event_id`** |
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
  email: "john.smith@example.com",
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

**Request** — `email` is the only required field. Also accepts `ip_hash`, `asn`,
`ip_country`, `declared_country`, `sensor_token`, `phone`, `username`,
`referrer`. See [registration screening](../concepts/registration-screening.md)
for what each is worth.

**Verdict**

| Field | Notes |
| --- | --- |
| `registration_id` | Pass to `identity.linkRegistration()`. `null` when `degraded` |
| `tier` | Open ordered scale. **Compare, never switch** |
| `score` | `[0,1]`, for your own thresholds |
| `reasons` | Up to three, most significant first. Never `null` — `[]` instead |
| `duplicate` | True on an idempotent replay |
| `shadow_mode` | True during warm-up, when `tier` is pinned to `0` |
| `degraded` | **True when this is the SDK's fail-open default, not a real answer** |
| `error` | The underlying `VectoralError`, when `degraded` |

`RegistrationTier` exports `Allow: 0`, `Challenge: 1`, `StepUp: 2` as named
constants for comparison. It is not an exhaustive enum.

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

Returns `score`, `tier` (`"low" | "medium" | "high"`), `reasons`,
`baseline_ready`, `shadow_mode`, `deep_mode_active`, and on a fail-open failure
`degraded: true`.

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

**Never fails open** — handle or queue its errors. Omit `inference_cost_usd` and
the server computes cost from its own rate table.

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

## Errors

```ts
import { VectoralError, VectoralConfigError } from "@vectoral/sdk";

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
import { generateSalt, suggestSaltId } from "@vectoral/sdk";
```

`generateSalt()` returns 32 random bytes as hex. `suggestSaltId()` returns
`s_YYYY_MM`. Both are for bootstrapping and rotation — call them in a one-off
script, never at process start. See [salts](../concepts/salts.md).

## Low-level fingerprinting

```ts
import { computeFingerprint, conversationKey } from "@vectoral/sdk";
```

Exported for integrations that precompute fingerprints (a proxy, a batch
importer) and attach `request.prompt_fingerprint` themselves. Most callers
should use `prompt_text_to_fingerprint` and let the SDK do it.
