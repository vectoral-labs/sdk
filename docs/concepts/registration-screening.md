# Registration screening

Check a signup **before you create the account**, and get back one of three
actions: let it through, challenge it, or ask for a payment instrument.

```ts
const verdict = await vectoral.registrations.score({
  email: "john.smith@example.com",
  ip: req.ip,
  event_id: pendingSignup.id,
});
```

`email` is the only required field.

## Acting on the tier

| Tier | Meaning | Typical action |
| --- | --- | --- |
| `0` | Allow | Create the account |
| `1` | Challenge | Show a captcha, then create the account |
| `2` | Step up | Require a payment instrument or identity verification |

**Compare, do not switch.** The tier is an open, ordered scale — higher means
more friction — and new tiers may be added without a new API version.

```ts
if (verdict.tier >= RegistrationTier.StepUp) return requireStepUp();
if (verdict.tier >= RegistrationTier.Challenge) return showCaptcha();
return createAccount();
```

A client that compares keeps working when a tier is added. One that switches on
an exhaustive `0 | 1 | 2` silently falls through.

`score` is the underlying `[0,1]` risk value. You do not need it to integrate —
it is there so you can tune your own thresholds or apply a stricter policy than
the tiers imply.

`reasons` names up to three contributing factors, most significant first. Useful
in your logs and in support conversations; **do not branch on them**, as the set
will grow.

| Reason | What it means |
| --- | --- |
| `email_infrastructure` | The domain cannot receive mail, or the address is a role mailbox |
| `fresh_domain` | The email domain was registered very recently |
| `disposable_email` | A known throwaway mailbox service, or one behaving like it |
| `email_reputation` | The domain is blocklisted or has a bad history with you |
| `address_permutation` | One of a family of variations on the same name |
| `registration_wave` | Part of a burst of signups sharing an origin |
| `device_reuse` | The same device has registered repeatedly |
| `client_automation` | The browser looks scripted rather than driven by a person |
| `form_behavior` | The form was filled the way a script fills it |
| `origin_risk` | Datacenter, VPN, Tor, or an origin inconsistent with the claims |

## What to send, in order of value for the effort

Every optional field you omit produces an **absent** signal, never a favourable
one. Omitting `device_fingerprint` does not mean "no device reuse"; it means
nobody can tell.

1. **`device_fingerprint`** — the single highest-value optional field. See
   [fingerprinting](fingerprinting.md).
2. **`ip`** — the end user's browser IP at submit, **not your server's**. Feeds
   datacenter, VPN, Tor and geography checks plus per-address and per-subnet
   velocity. Raw addresses are never stored; they become keyed one-way tokens on
   arrival.
   Prefer `ip_hash` if you would rather not send addresses — but note a token
   cannot be aggregated by subnet, so per-`/24` and per-`/64` velocity go
   absent. Use the same shape on every endpoint; mixing raw addresses on one and
   tokens on another splits your own view.
3. **`client`** — browser-environment tells. `webdriver` is cheap and strong when
   true, and **`"webdriver": false` is a real, useful negative** while omitting
   it says nothing.
4. **`form`** — fill telemetry. `pasted` is the valuable bit: scripted fills
   paste, humans type. `corrections` counts backspaces — humans make them,
   scripts do not.
5. **Context** — `declared_country`, `user_agent`, `phone`, `username`,
   `referrer`, `asn`, `ip_country`, `sensor_token`.

`@vectoral/browser`'s `signupSignals()` produces 1, 3 and 4 in one call, already
in the right shape.

## Linking the account back

The response carries a `registration_id`. When the signup succeeds, send it
back:

```ts
await vectoral.identity.linkRegistration(newAccountId, verdict.registration_id, {
  ip: req.ip,
});
```

Scoring works either way — what this buys is the connection between a signup and
the account it became, so that a later `labels.submit({ label: "fraud" })`
reaches back to the registration that created it. That is the feedback loop.

- Send it once, on the `signup` event. Repeats are harmless.
- **It can arrive late.** If you gate account creation on email verification, the
  account may not exist for hours. Store the `registration_id` with your
  pending-signup record and send it whenever the account is finally created.
- An unknown or already-linked id is ignored, never rejected.

## Latency

The call is synchronous and made once, at submit. Some checks need live lookups
against third parties — mail records, domain age, blocklists — cached
aggressively but slow the first time a domain is seen.

```ts
await vectoral.registrations.score({ email, deadline_ms: 600 });
```

`deadline_ms` defaults to `400` and is **clamped** to `[250, 2000]` rather than
rejected. When a lookup misses the deadline its signals are simply absent from
that verdict — **and the lookup still finishes in the background**, so the next
signup from that domain has them. A tight deadline costs first-sightings, not
correctness.

The SDK raises its own HTTP timeout above whatever deadline you set, so you
never abort locally on a server that was about to answer.

## Rolling it out

1. **Integrate and log.** Send the call, log `tier`, `score` and `reasons`, act
   on nothing. The warm-up window pins `tier` to `0` anyway, so you can confirm
   the wiring without challenging anybody.
2. **Check the distribution.** After real traffic, count how many signups land in
   each tier. If a large share are tier 1 or 2, do not start enforcing —
   something in what you are sending is probably misleading us. Ask.
3. **Enforce the top tier first.** Act on `tier >= 2` only. Smallest population,
   friction most justified.
4. **Then challenge.** Add `tier >= 1` behind a percentage rollout, and watch
   your completion rate as well as your fraud rate. A challenge that stops fraud
   and also stops customers is not a win.

## Two things worth knowing

**Correlation needs history.** The strongest checks — repeated devices, bursts
from one origin, families of permuted addresses — compare this signup against
your *other* signups. On day one there is nothing to compare against and scores
are conservative. This is expected; it sharpens within hours of real volume.

**Send the ones you reject, too.** If your own rules block a signup before you
call, it never joins the corpus that catches the next one. A farm's rejected
attempts are part of the same burst as its successful ones.
