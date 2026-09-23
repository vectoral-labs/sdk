# Failure and idempotency

## Fail-open

Vectoral fails open server-side: an internal problem yields a permissive verdict,
never a `4xx` or `5xx`. The SDK extends the same posture to its own transport,
because the failure you actually have to plan for is not Vectoral being broken —
it is the network between you and it.

With `failOpen: true` (the default), a network error, timeout, or HTTP error on
a **scoring** call returns a clean verdict instead of throwing:

```ts
const verdict = await vectoral.registrations.score({ email });
// network down -> { tier: 0, score: 0, registration_id: null, degraded: true, error }
```

| Call | Fails open? |
| --- | --- |
| `registrations.score()` | yes |
| `inference.score()` | yes |
| `inference.postCall()` | **no** |
| `identity.record()` | **no** |
| `labels.submit()` | **no** |

Scoring calls sit in front of a user-facing flow, so a failure there must not
take the flow down. The other three are writes with no verdict to degrade to;
swallowing their errors would just lose data quietly.

## `degraded` is the part people forget

A fail-open verdict is indistinguishable from a genuinely clean one unless you
look:

```ts
if (verdict.degraded) {
  metrics.increment("vectoral.degraded");
}
```

A flow permanently running at `tier: 0` because of an expired API key looks
exactly like a flow where every signup is legitimate. Wire up `onError` at
construction so it is impossible to miss:

```ts
const vectoral = new Vectoral({
  apiKey: process.env.VECTORAL_API_KEY,
  onError: (err, context) => logger.warn({ err, context }, "vectoral degraded"),
});
```

Set `failOpen: false` in tests and in batch jobs, where an exception is more
useful than a silent zero.

## Idempotency, and why it gates retries

Every Vectoral write endpoint mints a new row per call. A retry after a response
lost in transit therefore **double-writes**: two registrations for one real
signup, and no way to tell which is canonical.

`event_id` fixes this. A repeat of the same `(customer, event_id)` returns the
original verdict with `duplicate: true` and writes nothing.

So the SDK ties the two together: **retries are only applied to calls that carry
an `event_id`.**

```ts
// retried up to `retries` times on a transient failure
await vectoral.registrations.score({ email, event_id: pendingSignup.id });

// never retried — a retry here could double-write
await vectoral.registrations.score({ email });
```

This is not configurable, and `retries` defaults to 2. Supplying an `event_id`
is what buys you retries; there is no setting that makes an unsafe retry safe.

### Choosing an `event_id`

Derive it from **your own record** — the primary key of your pending-signup row,
your idempotency key for the request. Do not derive it from a transport message
id, a timestamp, or a UUID minted at call time: those change on the retry, which
is exactly when you need them not to.

## What counts as transient

Only these are retried, and only with an `event_id`:

- network errors
- timeouts
- HTTP `5xx`

A `4xx` is never retried — it means the request was wrong, and sending it again
will not make it right.

```ts
try {
  await vectoral.inference.postCall(event);
} catch (err) {
  if (err instanceof VectoralError && err.transient) {
    await queue.enqueue(event);   // retry later, out of the request path
  } else {
    logger.error({ err }, "post-call telemetry rejected");
  }
}
```

## Timeouts

`timeoutMs` defaults to 5000. For `registrations.score()`, the SDK derives its
timeout from `deadline_ms` instead — always above it, so you never abort locally
on a server that was one moment from answering. A client timeout below the
server's deadline converts good verdicts into fail-open zeros, which is the
failure mode that looks like everything working.
