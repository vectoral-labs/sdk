# Inference scoring

Score an account's behaviour before you spend money on its LLM call, then report
what the call actually cost.

```ts
const verdict = await vectoral.inference.score({
  account_id: "user_abc123",
  session_id: sessionId,
  request: { ip: req.ip, model_requested: "claude-opus-5" },
});

if (verdict.tier === "high") return refuse();

const completion = await llm.complete(prompt);

await vectoral.inference.postCall({
  account_id: "user_abc123",
  session_id: sessionId,
  model: "claude-opus-5",
  prompt_tokens: completion.usage.input_tokens,
  completion_tokens: completion.usage.output_tokens,
  latency_ms: elapsed,
});
```

## Both halves, or neither

`postCall()` is not optional telemetry you add later. Token velocity, cost per
account, burst detection, and model mix all derive from it. A score-only
integration asks a question whose evidence it declined to provide, and the
scores it gets back will be thin for as long as that lasts.

It is also the one call in the SDK that **never fails open**: telemetry you
silently drop is telemetry you never notice missing. Handle its errors, retry it
with an `event_id`, or queue it — but do not swallow it.

## Reading the response

```ts
{
  score: 0.83,            // calibrated [0,1]; 0 = clean
  tier: "high",           // low <0.4 | medium <0.7 | high >=0.7
  reasons: ["machine_paced", "birth_cohort"],
  baseline_ready: true,
  shadow_mode: false,
  deep_mode_active: false,
}
```

Two flags decide whether the score is enforcement-grade:

- **`baseline_ready: false`** — the per-account baseline is still forming. The
  score is real but provisional. Treat it as advisory.
- **`shadow_mode: true`** — you are inside the warm-up window. The verdict you
  receive is masked to a clean value while the real one is still computed and
  recorded.

`algorithm`, `algorithm_version` and `service_version` are diagnostics. Log
them; do not branch on them. They are opaque strings and new values can appear
without a version bump.

## Reasons

`reasons` names up to three contributing factors, most significant first. They
are for your logs and for support conversations — **the field to act on is
`tier`**.

**The set is open.** Reasons are produced by the scoring algorithm running
server-side, which ships independently of the SDK, so a code you have never seen
can arrive in a response without an SDK release and without an API version bump.
The `ReasonCode` type accepts any string for exactly that reason. Never write an
exhaustive `switch` over it; it will fall through in production, on the day a new
signal ships, on the accounts that triggered it.

That is also why the tables below are a *reference for looking a code up*, not a
contract. If you see one that is not here, it is new rather than wrong — log it
and ask us.

### Account behaviour

The ordinary case: the algorithm's own findings. This is the group that grows.

| Reason | What it means |
| --- | --- |
| `machine_paced` | Request timing with no human rhythm — bursts, sub-second cadence, or never idle |
| `hidden_telemetry` | Context that should be present is missing or unusable, e.g. an absent or non-routable client IP |
| `birth_cohort` | One of a set of accounts created together and behaving as a set |
| `probing` | Enumerating models or capabilities rather than using them |
| `resource_shape` | The size and shape of requests reads as extraction rather than use |
| `value_extraction` | Cost accrued fast, or far faster than the account's own estimates implied |
| `resource_extraction` | Sustained high token throughput |
| `datacenter_origin` | The request came from hosting or cloud address space rather than a consumer network |
| `account_risk` | Risk in the account context **you sent us** — unverified email, no payment instrument, prior chargeback |
| `synthetic_noop` | Traffic with the shape of a health check or generated load rather than real use |

### Operational

These do not come from the algorithm. Each means something overrode or replaced
the verdict, so they lead the list when present — and any codes after them may
belong to a score that was not the one acted on.

| Reason | What it means |
| --- | --- |
| `account_blocked` | You blocked this account; the verdict reflects your decision, not ours |
| `spend_cap_exceeded:account` | The account's spend cap is tripped |
| `spend_cap_exceeded:org` | The organisation's spend cap is tripped |
| `scoring_unavailable` | Scoring did not run. **Fail-open**: the response is a clean verdict that means "no opinion", not "clean account" |
| `reputation_discount` | An established good history pulled the score down |

### Browser signals

Present only when a verified sensor token was fused into this score. If you have
not deployed `@vectoral-labs/browser`, you will never see one.

`webdriver_present`, `automation_signature`, `headless_browser`,
`no_accept_languages`, `missing_chrome_object`, `no_human_interaction`,
`no_pointer_activity`, `cursor_teleport`, `thin_fingerprint`.

> Registration screening has its **own, separate** reason vocabulary — a
> `registrations.score()` verdict never returns a code from this page. See
> [registration screening](registration-screening.md).

## What to send

| Field | Why it matters |
| --- | --- |
| `account_id` | Required. The join key for all scoring history — stable per end user, not per session |
| `request.ip` | The IP **your server** observed, from your trusted proxy header. A browser-reported IP is worth nothing |
| `session_id` | Stored for forensic correlation, and doubles as the conversation key for prompt fingerprints |
| `request.model_requested` | Model-mix features |
| `request.estimated_prompt_tokens` | Cost projection before the call |
| `account.first_seen` | Account age; sharply improves early scoring |
| `request.session_signals` | Behavioural shape — see below |

### What actually goes on the wire

Every field above is sent as you supply it. That is obvious for `account_id` and
`request.ip`, and easy to forget for the free-form ones — `account.subscription_tier`
is your own label, transmitted verbatim, so `"trial_restricted"` leaves your
network as those exact characters.

It matters if anything on your egress path inspects outgoing request bodies. A
DLP rule or prompt-leak self-check that scans for words from the user's prompt
will match a label that happens to share one, and blame the SDK for a leak that
did not happen. Prefer stable internal labels, and never put user-supplied text
in these fields.

The prompt itself is the exception and the one that matters.
`prompt_text_to_fingerprint` is **always** stripped before the request is built —
whether or not fingerprinting is configured — so the raw text is never in the
body. Verify it on your own wire if you like.

What is *not* unconditional is the fingerprint. One is computed and attached only
when fingerprinting is configured, the call actually carries text, and that text
clears the 8-token floor — below it there is not enough to hash stably, so
nothing is sent rather than something noisy. The SDK warns once via `onWarning`
in the first two cases, so a misconfiguration surfaces instead of looking like
clean traffic. See [fingerprinting](fingerprinting.md).

### `session_signals` has three states, not two

Omitting the block and sending `{}` mean different things:

- **absent** — session-derived signals are skipped entirely.
- **present** — they participate, even if every field inside is zero.

And `interaction_events_count: 0` is not "no data"; it is a meaningful
scripted-shaped signal. Send the block when you can measure it, omit it when you
cannot, and do not fill it with zeros to look complete.

## Prompt fingerprinting

Optional, off by default, and the reason a reseller farm running one prompt
across a thousand accounts is visible at all. Prompt text never leaves your
process:

```ts
request: { prompt_text_to_fingerprint: userPrompt }
```

See [fingerprinting](fingerprinting.md) and [salts](salts.md).

## Labels

```ts
await vectoral.labels.fraud("user_abc123", "chargeback, 2026-09-14");
await vectoral.labels.legitimate("user_def456");
```

Report the verdicts you reach yourself — chargebacks, bans, support
resolutions. **Label legitimate accounts too.** A corpus of only-fraud labels
teaches a model nothing about where the boundary is.
