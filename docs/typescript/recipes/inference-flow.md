# Recipe: the inference flow

Score, call the model, report the cost. All three, or the scoring has nothing to
work with.

## The wrapper

```ts
import { Vectoral, VectoralError } from "@vectoral-labs/sdk";
import type { PostCallEvent } from "@vectoral-labs/sdk";

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
        // Count what YOUR server recorded. Every other field in this block is
        // server-derived; this one used to come straight off the request body,
        // and it is the signal that separates scripted traffic from human —
        // so a caller could inflate it to look human and lower its own score.
        interaction_events_count: req.session.interactionEvents,
        is_first_request_in_session: req.session.requestCount === 0,
      },
      prompt_text_to_fingerprint: prompt,      // hashed locally, never sent
    },
  });

  if (verdict.duplicate) {
    // A replay drops `blocked` and `baseline_ready`. Both can be rebuilt from
    // what it does restore: hard controls name themselves in `reasons`, and on
    // a server response `baseline_ready` is the inverse of `shadow_mode`. Safe
    // to rely on here specifically, because `duplicate` is only ever true on a
    // real response — the SDK's fail-open default sets both flags false.
    const hardControl = verdict.reasons.some(
      (r) => r === "account_blocked" || r.startsWith("spend_cap_exceeded"),
    );
    if (hardControl) throw new AbuseError(verdict.reasons);
    if (verdict.tier === "high" && !verdict.shadow_mode) {
      throw new AbuseError(verdict.reasons);
    }
  } else {
    // A hard control is not a risk judgement, so it is not subject to the
    // warm-up guard below. Refuse it unconditionally.
    if (verdict.blocked) throw new AbuseError(verdict.reasons);

    // Enforce the risk verdict only once you have left observe-only.
    if (verdict.tier === "high" && verdict.baseline_ready && !verdict.degraded) {
      throw new AbuseError(verdict.reasons);
    }
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

**Replays are handled separately, and must be.** If you send an `event_id` and
your own caller retries, the second response is a replay: `score`, `tier`,
`reasons` and `shadow_mode` are the original, but `blocked` and `baseline_ready`
are not restored and arrive `false` whatever they really were.

Run a replay through the guards below and both pass, so a blocked account gets
served. Refusing on `tier` alone overcorrects the other way — a merely risky
verdict replayed during warm-up would be refused when the same verdict, not
replayed, is allowed, so a retry would turn an allowed request into an error.

Both lost fields can be rebuilt from what survives. Hard controls name
themselves in `reasons` (`account_blocked`, `spend_cap_exceeded:*`), and on a
server response `baseline_ready` is the inverse of `shadow_mode`, which is
restored.

That inverse holds for responses the server sent, not for every `ScoreResponse`
you can hold: the SDK's fail-open default sets `baseline_ready`, `shadow_mode`
**and** `degraded` such that both flags read `false`. It is safe to lean on
inside this branch only because `duplicate` is never true on that default.

If you do not send `event_id`, `duplicate` is never true and this branch costs
you nothing. That is a reasonable reason not to send one.

The `blocked` check comes first and deliberately sits outside the guards below.
`blocked` means you or your spend caps already decided — a manual block or a
tripped cap — and that decision should not wait on a warm-up window. Folding it
into the guarded branch is the bug worth avoiding here: during warm-up
`baseline_ready` is `false`, so a single combined condition would let a blocked
account straight through.

Three guards on the risk branch, each earning its place:

| Guard | Without it |
| --- | --- |
| `baseline_ready` | You enforce during your warm-up window. On a server response it is the inverse of `shadow_mode`, and since the verdict is real and unmasked on this endpoint, it is the only thing stopping you. Do not read the inverse backwards: the SDK's fail-open default sets **both** to `false`, which is what `!degraded` is for |
| `!degraded` | Harmless — a degraded verdict is `tier: "low"` — but stating it keeps the intent readable when the fail-open default changes |
| `tier === "high"` | Enforcing on `medium` is a rate-limit decision, not a fraud decision |

During the warm-up window `shadow_mode` is `true` and `baseline_ready` is
`false`. The verdict itself is real and unmasked — this endpoint never pins it —
so it is the `baseline_ready` guard, and nothing else, that makes this code safe
to deploy before you are ready to enforce.

### Every signal you send should be one you measured

The verdict is only as trustworthy as its inputs, and a verdict that gates
enforcement is worth attacking. `session_signals` is the exposed surface:
`interaction_events_count` is what distinguishes scripted traffic from human,
so a caller who can set it can lower their own score.

Take these from server-side session state, never from the request body. If a
value genuinely has to come from the client, clamp it to a sane range and treat
it as a hint rather than evidence:

```ts
const events = Math.min(Math.max(Number(req.body.interactionEvents) || 0, 0), 500);
```

The same applies to anything the browser reports —
[`registration screening`](../../concepts/registration-screening.md) makes the
point for `client.fingerprint_anomaly`, and the signup recipe's
`sanitizeClient()` is the pattern.

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
