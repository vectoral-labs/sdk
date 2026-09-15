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
  reasons: ["token_velocity_inhuman_burst", "datacenter_ip"],
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
