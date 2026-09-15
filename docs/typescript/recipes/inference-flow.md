# Recipe: the inference flow

Score, call the model, report the cost. All three, or the scoring has nothing to
work with.

## The wrapper

```ts
import { Vectoral, VectoralError } from "@vectoral/sdk";

const vectoral = new Vectoral({
  apiKey: process.env.VECTORAL_API_KEY,
  fingerprint: {
    enabled: true,
    salt: process.env.VECTORAL_FINGERPRINT_SALT,
    saltId: process.env.VECTORAL_FINGERPRINT_SALT_ID,
  },
  onError: (err, context) => logger.warn({ err, context }, "vectoral degraded"),
});

if (!vectoral.fingerprintingActive) {
  logger.error("prompt fingerprinting is configured but not active — check the salt");
}

export async function guardedCompletion(req: Request, prompt: string) {
  const accountId = req.user.id;
  const sessionId = req.session.id;

  const verdict = await vectoral.inference.score({
    account_id: accountId,
    session_id: sessionId,
    account: {
      first_seen: req.user.createdAt.toISOString(),
      subscription_tier: req.user.plan,
    },
    request: {
      ip: req.ip,                              // observed by YOUR server
      user_agent: req.get("user-agent"),
      model_requested: MODEL,
      estimated_prompt_tokens: estimateTokens(prompt),
      session_signals: {
        ms_since_last_request: Date.now() - req.session.lastRequestAt,
        interaction_events_count: req.body.interactionEvents,
        is_first_request_in_session: req.session.requestCount === 0,
      },
      prompt_text_to_fingerprint: prompt,      // hashed locally, never sent
    },
  });

  // Enforce only on a verdict that is actually enforcement-grade.
  if (verdict.tier === "high" && verdict.baseline_ready && !verdict.degraded) {
    throw new AbuseError(verdict.reasons);
  }

  const started = Date.now();
  const completion = await llm.complete({ model: MODEL, prompt });

  await reportUsage({
    account_id: accountId,
    session_id: sessionId,
    model: MODEL,
    prompt_tokens: completion.usage.input_tokens,
    completion_tokens: completion.usage.output_tokens,
    latency_ms: Date.now() - started,
    event_id: req.id,
  });

  return completion;
}
```

## Reporting usage without losing it

`postCall()` never fails open, which is the point: it is the evidence every
later score is computed from. Do not wrap it in a bare `catch {}`.

```ts
async function reportUsage(event: PostCallEvent) {
  try {
    await vectoral.inference.postCall(event);
  } catch (err) {
    if (err instanceof VectoralError && err.transient) {
      // `event_id` makes the replay safe — the server dedupes it.
      await telemetryQueue.enqueue(event);
    } else {
      logger.error({ err, event }, "post-call telemetry rejected");
    }
  }
}
```

Reporting usage is also the one place worth doing out-of-band if your latency
budget is tight: it happens after the user already has their answer.

## Enforcement, carefully

Three guards on the branch above, each earning its place:

| Guard | Without it |
| --- | --- |
| `baseline_ready` | You enforce against a provisional score on accounts too new to judge |
| `!degraded` | Harmless — a degraded verdict is `tier: "low"` — but stating it keeps the intent readable when the fail-open default changes |
| `tier === "high"` | Enforcing on `medium` is a rate-limit decision, not a fraud decision |

During the warm-up window `shadow_mode` is `true` and the verdict you see is
masked clean, so this code is safe to deploy before you are ready to enforce.

Start by logging the distribution of `score` against your own outcomes. Enforce
only once you have seen it.

## Login events

Cheap, high-signal, and not per-request:

```ts
await vectoral.identity.record({
  account_id: user.id,
  event_type: "login",
  ip: req.ip,
  event_id: `login-${session.id}`,
});
```

Dedupe on your side — once per session per IP is the intent. Use the same IP
shape here as on `inference.score()`: mixing raw addresses on one and `ip_hash`
tokens on the other splits your own sybil graph.
