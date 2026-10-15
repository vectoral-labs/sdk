# Server-side integration — API

Agent-facing instructions for adding Vectoral to a project **with no JavaScript
toolchain** — Python, Go, Ruby, PHP, Java, or any stack where you cannot add npm
packages. If the project is TypeScript or JavaScript, read
[`SERVERSIDE_TS.md`](SERVERSIDE_TS.md) instead.

Call the HTTP API directly. Base URL `https://api.vectoral.cloud`; the credential
is a **secret API key** (`vg_live_…`) sent as `Authorization: Bearer`, and it is
**server-side only**.

Vectoral guards **one** endpoint: the backend route that makes your LLM call.
Not every route, not your login page — the expensive one. Three calls are
required; two more sharpen the verdict and confirm it landed.

## Step 1 — Score before the LLM call

From the route that calls the LLM, before you run inference:

```http
POST https://api.vectoral.cloud/v1/score
Authorization: Bearer vg_live_…
Content-Type: application/json
```

```json
{
  "account_id": "<the authenticated user's id>",
  "session_id": "<optional; your session identifier>",
  "request": {
    "ip": "<the IP your server observed>",
    "user_agent": "<the request's user-agent>",
    "model_requested": "<the model you are about to call>",
    "estimated_prompt_tokens": 1200
  }
}
```

The response is one fused verdict over the request and account signals:

```json
{
  "score": 0.83,
  "tier": "high",
  "reasons": ["machine_paced", "birth_cohort"],
  "baseline_ready": true,
  "shadow_mode": false,
  "deep_mode_active": false,
  "blocked": false,
  "signals_fused": false
}
```

`score` is calibrated `[0,1]`; `tier` bands it (`medium` at `>=0.30`, `high` at
`>=0.60`, and not a pure function of `score` — automated traffic is lifted to at
least `medium` whatever it scored). **`tier` is the field to act on.** `reasons`
is an open set for your logs and support conversations — never write an
exhaustive `switch` over it.

## Step 2 — Log the verdict, do not block yet

Ship in **log-only** mode first: log `score`, `tier`, and `reasons` alongside the
request, then call the LLM as normal. New accounts start in a warm-up window
where `shadow_mode` is `true` and `baseline_ready` is `false`, so blocking on the
score would hit real users. Once you have watched real traffic and
`baseline_ready` is `true`, add enforcement — for example reject `tier: "high"`
before paying for inference.

**One exception.** If `blocked` is `true`, a human manually blocked the account or
a spend cap tripped: the tier is already forced to `high` and the score to `1.0`.
Honour it immediately — reject without calling the LLM. Check `blocked` **on its
own**, before the risk branch: the usual guard also requires `baseline_ready`,
which is `false` throughout warm-up, so a combined condition lets a blocked
account straight through.

## Step 3 — Report usage after the call

Once the LLM responds, POST the actual token usage from the same route:

```http
POST https://api.vectoral.cloud/v1/events/post-call
Authorization: Bearer vg_live_…
Content-Type: application/json
```

```json
{
  "account_id": "<the same id as the score call>",
  "session_id": "<optional; the same session>",
  "model": "<the model you called>",
  "prompt_tokens": 1187,
  "completion_tokens": 642,
  "latency_ms": 2310
}
```

This is **not optional telemetry**. Token velocity, cost per account, burst
detection, and model mix all derive from it; a score-only integration gets thin
scores for as long as it lasts. Fire-and-forget it, but **do not swallow
failures** — this call never fails open, so handle or queue its errors.

Token counts have three states, not two: **omitted means "not measured"; `0` is
real evidence**, and a zero completion count is a tell for synthetic traffic. Do
not coalesce a missing count to zero — for a modality with no completion
(embeddings, tts, stt, rerank) that asserts a fraud signal. Omit the field.

## Step 4 — Send identity signals at auth time

At signup, login, and dashboard load, POST a lightweight signal carrying the
user's real IP:

```http
POST https://api.vectoral.cloud/v1/identity
Authorization: Bearer vg_live_…
Content-Type: application/json
```

```json
{
  "account_id": "<the authenticated user's id>",
  "event_type": "signup",
  "ip": "<the client IP>",
  "user_agent": "<the request's user-agent>"
}
```

`event_type` is `"signup"`, `"login"`, or `"dashboard"` (defaults to `login`).
Cheap, no scoring, and best-effort — dedupe to roughly once per session. This is
what makes the per-account baseline ready sooner and feeds the sybil signals from
accounts that have not made an inference call yet.

## Step 5 — Send the high-yield signals

Steps 1–4 work with `account_id`, `ip`, `user_agent`, and `model_requested`, but
several abuse patterns stay undetectable however much traffic accumulates —
most importantly **account farms sharing one script**. Add these where you can:

| Add | Lets us detect |
| --- | --- |
| `session_id` on the score call | abnormal session volume |
| `request.session_signals.ms_since_signup` | accounts that sign up and immediately hammer the API |
| `request.session_signals.interaction_events_count` | scripted use with no real UI interaction |
| `request.prompt_fingerprint` | prompt repetition, known-bad templates |
| `request.prompt_fingerprint.band_keys` | **account farms sharing one script** |
| `account.context.plan_type`, `has_payment_method` | account risk |
| `model` on the post-call event | reseller model mix |

`session_signals` has three states: omitting the block skips session signals
entirely, while sending it (even `{}`) makes them participate, and
`interaction_events_count: 0` is a meaningful scripted-shaped value, not "no
data". Send it when you can measure it, omit it when you cannot.

`prompt_fingerprint` is computed **in your process** from the prompt text; we
never receive the prompt itself. `band_keys` is optional inside that block —
skipping it leaves cross-account reuse undetectable, so send it.

Do **not** implement `request.prompt_text` on your own judgement: it sends actual
prompt content to Vectoral and unlocks nothing the fingerprint does not. The
fingerprint is the privacy-preserving equivalent.

**If you cannot send raw client IPs,** send `ip_hash` instead — a one-way token
you compute with your own key — alongside `asn` and `ip_country` for coarse
equivalents. Use **one stable key for your whole fleet**, hash the canonicalised
address, and do not truncate; rotating the key or mixing raw `ip` on some calls
and `ip_hash` on others splits your own sybil graph, silently. Use the same IP
shape on `/v1/score` and `/v1/identity` — the accounts-per-IP query unions both.

## Step 6 — Check what your integration is actually sending

One call tells you which signals your requests carry and, therefore, which abuse
patterns you cannot yet detect:

```http
GET https://api.vectoral.cloud/v1/integration/status?window=7d
Authorization: Bearer vg_live_…
```

It lists each of the three request endpoints — `/v1/score`,
`/v1/events/post-call`, `/v1/identity` — with the live calls it received in the
window, and per signal the fraction of those calls that carried it. Use
`window=1h` to confirm a change you just deployed. `window` is one of `1h`,
`24h`, `7d` (default), or `30d`.

- All three endpoints are always listed, even at `calls: 0`.
- `present` is **`null` when `calls` is `0`** — that means "no traffic in this
  window", not "you are not sending it". Do not read it as a missing field.
- `detections_unavailable` is the set of abuse patterns nothing in the window
  backs. It is empty when you have no traffic: absence of data is not absence of
  signal.
- This one is **not** behind a flag — every integration has it, and it is useful
  **before** you have sent anything, because it answers "what could I send".
  Imported history never counts toward `calls`.

## Step 7 — Backload your history (optional)

If you have an export of past events, load it at its original timestamps so
Vectoral can score your history instead of waiting out the warm-up window. This
is the one step here that is **only available where the import feature is
enabled for your account**; where it is off, both routes are a plain `404`. If
you get a `404`, stop and ask — do not retry or invent another route.

```http
POST https://api.vectoral.cloud/v1/import
Authorization: Bearer vg_live_…
Content-Type: application/json
```

```json
{
  "import_id": "csv-export-2026-05",
  "events": [
    {
      "event_id": "evt-001",
      "type": "score",
      "event_time": "2026-05-01T09:12:00Z",
      "score": {
        "account_id": "user_abc123",
        "request": { "ip": "203.0.113.10", "model_requested": "gpt-4o", "estimated_prompt_tokens": 900 }
      }
    },
    {
      "event_id": "evt-002",
      "type": "post_call",
      "event_time": "2026-05-01T09:12:04Z",
      "post_call": { "account_id": "user_abc123", "model": "gpt-4o", "prompt_tokens": 900, "completion_tokens": 210 }
    },
    {
      "event_id": "evt-003",
      "type": "label",
      "event_time": "2026-05-02T00:00:00Z",
      "label": { "account_id": "user_abc123", "label": "legitimate" }
    }
  ]
}
```

- **Batch 1–1,000 events, body ≤ 8 MiB.** Exceeding either is a whole-batch
  `400`, not a per-event rejection.
- **`event_id` is required and yours.** Re-POSTing the same id reports
  `duplicate` rather than inserting again — that is what makes a large load over
  a flaky connection safely retryable.
- **`event_time` must be in the past**, and no older than 400 days by default. It
  becomes the row's own timestamp, not the load time.
- **The payload key must be exactly the event's `type`** — `score`, `post_call`,
  `identity`, or `label` — and exactly one of them must be set. Wrapping the
  payload in `event`, `data`, or `payload` is still **accepted**, but lands an
  empty payload and carries almost no signal. That failure is silent: the
  response reports it as accepted and `rejected` stays `0`. Verify by checking
  that loaded rows actually carry `model_requested` and token counts.
- **Partial success is per-event.** A malformed event is rejected individually
  with a `reason` (e.g. `event_time_in_future`) and the rest of the batch is
  accepted. Order does not matter; post batches in any order, in parallel, under
  one stable `import_id`.

Export **post-call events, not just score requests**. Token velocity, model mix,
and per-account spend all derive from `post_call` events; a score-only import
leaves that whole block empty once the backfill runs — the single most common way
to waste a large load.

Watch the job:

```http
GET https://api.vectoral.cloud/v1/import/csv-export-2026-05
Authorization: Bearer vg_live_…
```

Returns cumulative `received` / `accepted` / `duplicate` / `rejected` across every
batch under that `import_id`, the event-time span actually covered
(`first_event_time` / `last_event_time`), and up to the first 100 rejections with
reasons. `rejections_truncated: true` means that list is a sample.

**Imported rows are inert and carry no verdict until backfilled.** An import never
scores at ingest, never evaluates spend caps, never fires alerts, and is not
counted in live metrics — which is what makes a backload safe to run against a
production account. Until a background backfill computes features and scores each
row, it reads back from every endpoint with `score: 0` and `tier: ""`. A `0` there
means **"not scored", not "scored low-risk"**, and the two are indistinguishable
by the numbers alone — so do not compute accuracy, AUC, or any quality metric
against a freshly-loaded history; you would be measuring a column of zeros. Use
`GET /v1/data/status` to see how much of the load has been featured (`pending` /
`featured` / `failed`) before you read verdicts.

## Guardrails

- **Scoring calls fail open.** Give the score call a short timeout (1s is
  generous). On any error, timeout, or non-2xx, log it and serve the request as
  normal. **Writes do not fail open** — retry or queue a failed write, including
  a post-call usage report, without blocking the user's response. A silently
  dropped usage report is telemetry you never notice missing.
- **`account_id` must be stable.** It is the join key for all scoring history; a
  per-session or per-request id makes every request look like a brand-new account
  and nothing accumulates.
- **The key is server-side only.** Never ship `vg_live_…` to a browser or a
  mobile binary.
- **Pass an `event_id`** on anything your caller may retry. A repeated `event_id`
  replays the stored verdict instead of scoring twice. Note the replay does not
  restore `baseline_ready` or `blocked` (both come back `false`), so a replayed
  verdict can slip past the usual guard — `score` and `tier` are restored.

## Browser-side signals

Separate and optional. If the project also has a signup or app page in a browser,
it can collect device, automation, and form-fill signals and POST them to your
backend, which forwards them into the score call — see
[`BROWSER.md`](BROWSER.md). The standalone `<script>` there needs no build step,
so it fits an API-path project.

## Verify

- `POST /v1/score` returns a JSON verdict with a numeric `score` and a non-empty
  `tier`; the post-call and identity calls return `{ "ok": true }`.
- `GET /v1/integration/status?window=1h` then shows the calls landing and which
  signals are present.

## Where to read more

- [Inference scoring](docs/concepts/inference-scoring.md) — the score → call → telemetry loop
- [Registration screening](docs/concepts/registration-screening.md) — scoring a signup before the account exists
- [Salts](docs/concepts/salts.md) — read before enabling prompt fingerprinting
