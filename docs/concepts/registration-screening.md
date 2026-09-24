# Registration screening

Check a signup **before you create the account**, and get back one of three
actions: let it through, challenge it, or ask for a payment instrument.

```ts
const verdict = await vectoral.registrations.score({
  email: "john.smith@acmecorp.co.uk",
  ip: req.ip,
  event_id: pendingSignup.id,
});
```

`email` is the only required field.

## Before you test this

Two things will make a healthy integration look broken, and both happen during
evaluation rather than in production. Read this section before your first run —
it is cheaper than the afternoon it otherwise costs.

**Do not test with `@example.com`.** Reserved names cannot receive mail, and
non-deliverability is precisely what `email_infrastructure` exists to detect. So
it fires on every signup you send, unconditionally, and no test registration can
produce a clean score.

They are undeliverable in two different ways, and both are caught:

- `example.com`, `example.net` and `example.org` are delegated and publish a
  **null MX** (RFC 7505) — an explicit, standards-mandated declaration that the
  domain accepts no mail.
- `.test`, `.invalid`, `.localhost` and `.example` are special-use names
  (RFC 2606, RFC 6761) with **no public delegation**, so on an ordinary
  deployment there is no mail host to find. `.invalid` and `.example` have
  nothing to resolve at all; `.localhost` answers address queries with the
  loopback address by specification and returns a negative response to every
  other query type, `MX` included.

  `.test` is the one to avoid most. It can be made to resolve inside a private
  network configured for it — so against a **self-hosted** deployment, whose
  lookups use its own host's DNS, it may resolve and `email_infrastructure` may
  not fire at all. Undeliverable is a usable constant; *unpredictable* is not,
  and it means a clean result against your stack proves nothing about a cloud
  one.

On its own that is a floor under the score rather than a tier: one clean signup
on a reserved domain still lands at tier 0 under the default bands. What it costs
you is the ability to read the number — the signal you came to evaluate is
underneath a constant you introduced.

Repetition is what can push it over. The domain accumulates history **inside your
tenant**, so once enough synthetic signups match on it the same address space
also carries `disposable_email` and `email_reputation` — and with those stacked
on top, tier 0 may stop being reachable. How quickly depends on how much of your
traffic on that domain looked bad, and on your own tier floors; there is no fixed
count at which it flips.

Use a domain you control, or a plausible one you do not send mail to. Nothing in
this documentation uses a reserved domain, for this reason.

**Your integration testing is itself a registration wave.** Twenty synthetic
signups in ten minutes, from one or two origins, with names varying by a
counter, is an extremely good imitation of a signup farm — so `registration_wave`
and `address_permutation` fire.

Correlation is **keyed, not tenant-wide**. Each check needs a shared attribute,
so what gets swept up alongside your burst is what shares its email domain, exact
IP, `/24`, `/64`, ASN, device fingerprint, or address family. A genuinely
independent control is unaffected. One that differs from the burst only by a
counter is the same address family — and that is the control most people build.

**None of it is permanent**, either. The windows are bounded: bursts and
per-address velocity look back an hour; address families, device reuse and domain
reputation seven days. A domain you have burned recovers on its own — just not
inside the afternoon you are testing in.

The scoring is correct. The timing is unfortunate: it lands at the exact moment
someone is deciding whether this product works. What works instead:

- fresh, non-permuted identities per run — real-looking names, not `user001…user020`
- a different email domain per run
- space the runs out, or accept that the first minutes of a burst are correlated
- keep one control identity that you send **before** the burst, not during it, and
  make it independent — a different domain and network, not just a different name

The general form of both: correlation compares this signup against your other
signups that share something with it, so **what you send changes what you get
back next time**. That is the feature. It just also applies to your test traffic.

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

### `score` is not the tier, and you cannot recompute one from the other

`score` is a `[0,1]` risk value, reported so you can log it, watch its
distribution, and apply a policy *stricter* than the tier — refusing a trial
above `0.8`, say, even though that is still tier 1.

**Do not reimplement the banding from it.** Plotting the two against each other
will suggest you can: the tier does start as a band on the score. But three
mechanisms move it, and only the first is visible in `score`.

1. **The band.** Every signal that fires contributes a weighted amount to the
   score, and the score is cut into tiers. This is the part you can see.
2. **Score floors.** Two signals — device reuse and address permutation — also
   clamp the *score* upward when they fire, to a value above the shipping
   step-up cut. Still visible in the number, just no longer proportional to the
   rest of the evidence.
3. **Tier floors, which do not touch the score at all.** Two kinds: a built-in
   one that lifts any registration the correlation checks flagged as *one of
   many* to the challenge tier and **no further**; and the per-signal floors you
   configure, which can raise it to any tier you choose.

Mechanism 3 is what breaks a reimplementation, because it leaves no trace in
`score`. It is why two registrations with the same score can sit in different
tiers, and a lower-scoring one can sit higher.

**The cuts and the floors are yours to configure** — the band cuts, and a
per-signal tier floor for each of `email_infrastructure`, `fresh_domain`,
`disposable_email`, `email_reputation`, `registration_wave`, `device_reuse`,
`client_automation` and `free_provider`, are settings on your account.
Thresholds you hardcode today are thresholds that silently disagree with your own
settings page tomorrow.

So a `score → tier` table derived by observation is a second, competing policy
that drifts from the real one without ever erroring. Act on `tier`; keep `score`
for your logs and for policy you deliberately layer *on top of* the tier.

`reasons` names up to three contributing factors, most significant first. Useful
in your logs and in support conversations; **do not branch on them**, as the set
will grow — a new code can ship server-side without an SDK release or an API
version bump.

These are registration reasons. [Inference scoring](inference-scoring.md) has a
completely separate vocabulary; the two never mix in one response.

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
5. **`sensor_token`** — if you run the browser sensor, forward its token. It is
   the trusted, unforgeable join to the browser verdict, and it supersedes the
   plaintext `session_id` for that purpose.
6. **Context** — `declared_country`, `user_agent`, `phone`, `username`,
   `referrer`, `asn`, `ip_country`.

`@vectoral-labs/browser`'s `signupSignals()` produces 1, 3 and 4 in one call, already
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

`deadline_ms` defaults to `400` and is **clamped** to `[250, 6000]` rather than
rejected. The ceiling is a ceiling, not a recommendation — most integrations
should stay near the default. When a lookup misses the deadline its signals are simply absent from
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
   something in what you are sending is probably misleading us. Ask. Measure it
   on real traffic, not on the synthetic runs from
   [before you test this](#before-you-test-this), whose distribution is a
   property of how they were generated.
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
