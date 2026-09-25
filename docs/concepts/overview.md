# Overview

Vectoral answers three different questions about the same user, at three
different moments. They need different calls because they have different
evidence available.

| Moment | Question | Call |
| --- | --- | --- |
| Signup form submit | Is this arrival worth accepting? | `registrations.score()` |
| Before an LLM call | Is this account's behaviour abusive? | `inference.score()` |
| After the LLM call | What did it actually cost? | `inference.postCall()` |

Plus two that carry no verdict but make the others work:

| Call | Why |
| --- | --- |
| `identity.record()` | Signup/login events, and the link from a registration to the account it became |
| `labels.submit()` | Ground truth — the only thing that makes any of it improve |

## Why registration and inference are separate

`inference.score()` reads an account's accumulated behaviour: token velocity,
timing regularity, IP rotation, session shape. On a brand-new account there is
no behaviour to read, so it has nothing to say.

`registrations.score()` reads the *arrival* instead — the email address, the
network it came from, the browser that submitted the form, and above all how
this signup relates to every other signup you have sent. It runs before the
account exists.

Using one where you need the other gets you a confident-looking answer computed
from nothing.

## The loop

The single most common integration mistake is calling `inference.score()` and
stopping there. Half the signals — token velocity, cost per account, model mix —
come from `postCall()`. A score-only integration asks a question whose evidence
it declined to provide.

```
registrations.score()  →  account created  →  identity.record(registration_id)
                                                        ↓
                          inference.score()  →  LLM  →  postCall()
                                                        ↓
                                              labels.submit()  →  retraining
```

`labels.submit()` closes it. A label on an account reaches back through the
`registration_id` link to the signup that created it, which is how registration
screening learns what your fraud actually looks like rather than what fraud
looks like in general.

## What you always get back

Two properties hold across every scoring call:

**Internal failures fail open.** A database problem or a degraded dependency
yields a clean verdict, never a `4xx` or `5xx`. Your signup page and your
inference path are never blocked by Vectoral's availability. The SDK extends
this to its own transport — see [reliability](reliability.md).

**Omission is never innocence.** Every optional field you leave out produces an
*absent* signal, not a favourable one. No `device_fingerprint` does not mean "no
device reuse"; it means nobody can tell. This is deliberate — it stops a thin
integration from looking clean — but it does mean your coverage is proportional
to what you send.

## Warm-up

Your account begins in a shadow-mode window — one window per customer, not one
per end-user. Responses carry `shadow_mode: true`.

What that means differs by endpoint, and the difference matters. For
**registration screening** the tier is genuinely pinned to `0`, so you can
integrate and deploy without challenging anybody. For **inference scoring** the
verdict is real and unmasked throughout — if you want to observe rather than
enforce during warm-up, branch on `shadow_mode` yourself.
