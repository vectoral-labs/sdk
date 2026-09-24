# Salts

A fingerprint is a one-way digest of something identifying — a browser's
configuration, a prompt's wording. The salt decides **who can compare two
fingerprints**. That is the only thing it does, and getting it wrong is either a
privacy leak or a detector that cannot detect.

There are three tiers, and the SDK uses a different one in each place.

| Tier | Salt | Who can compare | Used for |
| --- | --- | --- | --- |
| Scoped | publishable site key (`pk_live_…`) | you, and Vectoral on your behalf | device fingerprints, in the browser |
| Confidential | secret tenant salt | you only | prompt fingerprints, on your server |
| Global | none | every customer who opted in | cross-customer prompt matching |

## Why the browser gets a publishable salt

`@vectoral-labs/browser` salts the device fingerprint with your **site key**, which is
public — it ships in your page source.

That is not an oversight. A secret shipped to the browser is not a secret; it is
a secret you have published and now believe in. Salting with the site key is
honest about what it buys, which is **scoping, not secrecy**: the same physical
device produces a different fingerprint for every Vectoral customer, so a
fingerprint leaked from your logs cannot be joined against another tenant's
users. It does not stop someone who has your site key from computing the
fingerprint of a device they control — and nothing shipped to the browser could.

The practical consequence: a device fingerprint is a **correlation key, not
evidence**. It tells you two signups came from the same browser. It does not
prove either was fraudulent, and it can be forged by anyone willing to run your
page in a modified browser. That is the right level of trust for it either way —
see [fingerprinting](fingerprinting.md).

```js
// The salt is the site key. No secret is involved and none is needed.
const { fingerprint } = await deviceFingerprint({ siteKey: "pk_live_abc" });
```

## Why prompt fingerprints get a secret salt

Prompt fingerprints are different in kind: the input is user-authored text, and
the space of plausible prompts is small enough to enumerate. An unsalted
fingerprint of "write a cover letter for a marketing role" is effectively
reversible — anyone holding the digest can confirm the prompt by guessing it.

So the tenant salt is a real secret, held only on your server:

```ts
const vectoral = new Vectoral({
  fingerprint: {
    enabled: true,
    salt: process.env.VECTORAL_FINGERPRINT_SALT,     // 128+ bits, secret
    saltId: process.env.VECTORAL_FINGERPRINT_SALT_ID // e.g. "s_2026_09"
  },
});
```

Prompt text never leaves your process. The SDK normalizes and hashes it
in-process and sends only the digest. `request.prompt_text_to_fingerprint` is
stripped from the outgoing body unconditionally — whether or not fingerprinting
is enabled.

Generate a salt once, with `generateSalt()`, and store it in your secret
manager:

```ts
import { generateSalt, suggestSaltId } from "@vectoral-labs/sdk";
console.log(generateSalt(), suggestSaltId()); // -> 64 hex chars, "s_2026_09"
```

**Do not call `generateSalt()` at process start.** A salt minted per deploy makes
every previously stored fingerprint incomparable, which silently turns the
feature off while leaving it looking enabled.

## What `saltId` is for

`saltId` is a label naming the salt generation a fingerprint was computed under.
It travels with every fingerprint so the server never compares values across a
rotation — two digests of the same prompt under different salts are unrelated
numbers, and comparing them would produce noise, not matches.

You do not need to rotate on a schedule. Rotate when the salt is exposed, or
when your own policy says to. The cost of rotation is real: fingerprints under
the old salt cannot be matched against ones under the new, so detection quality
dips until enough new traffic accumulates. A convention like `s_2026_09` makes
that visible in logs; any stable string works.

## The global tier is opt-in, and it is a real tradeoff

```ts
fingerprint: { enabled: true, shareGlobal: true, salt, saltId }
```

`shareGlobal` additionally computes an **unsalted** fingerprint, comparable
across every Vectoral customer who opted in. It catches a farm running the same
prompts against several victims at once — a pattern invisible from inside any
single tenant.

What you give up is the confidentiality argument above: an unsalted fingerprint
of a guessable prompt is confirmable by anyone holding it. Send it only for
traffic where that is acceptable, and do not enable it because it sounds
strictly better. It is strictly more comparable, which is the same property
viewed from either side.

`shareGlobal` without `enabled` throws at construction — it is a contradiction
in intent rather than a missing value, and silently ignoring it would ship an
unsalted fingerprint nobody asked for.

## Validation, and why it warns instead of throwing

The SDK refuses a salt that is missing, shorter than 32 characters, or a
well-known placeholder (`changeme`, `test`, …). In every case it **disables
fingerprinting with a warning rather than throwing**.

That asymmetry is deliberate. Fingerprinting is an enhancement; a score request
without one is merely less informed. A constructor that throws in production
because a salt was rotated badly is an outage. So misconfiguration costs you a
feature and a log line, never traffic.

Check `vectoral.fingerprintingActive` if you want to assert the feature is on:

```ts
if (!vectoral.fingerprintingActive) {
  logger.error("prompt fingerprinting is not configured");
}
```

## Quick reference

- Browser code gets the **site key** and nothing else. If you are about to put a
  secret in a bundle, stop.
- The tenant salt lives in your secret manager, is read from the environment,
  and is never logged.
- Changing a salt is a data event, not a config tweak. Pair it with a new
  `saltId`.
- `shareGlobal` is a disclosure decision. Make it once, deliberately.
