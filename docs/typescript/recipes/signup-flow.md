# Recipe: the signup flow, end to end

Browser collection → screening → account creation → the link back → a label
months later.

## 1. The signup page

```js
import { trackForm, signupSignals } from "@vectoral-labs/browser";

const form = document.querySelector("#signup");
// Start tracking on page load, not at submit — the point is HOW the form was
// filled, and by submit that has already happened.
const tracker = trackForm(form);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const signals = await signupSignals({
    siteKey: "pk_live_abc",   // publishable; safe in page source
    form: tracker,
  });

  const res = await fetch("/api/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: form.email.value,
      password: form.password.value,
      signals,
    }),
  });

  const { action } = await res.json();
  if (action === "captcha") return showCaptcha();
  if (action === "step_up") return showPaymentStep();
  window.location.href = "/welcome";
});
```

The browser never calls Vectoral. It posts to your endpoint, which is the only
place that holds the API key and the only place that knows the real client IP.

## 2. The screening endpoint

```ts
import { Vectoral, RegistrationTier } from "@vectoral-labs/sdk";
import { randomUUID } from "node:crypto";

const vectoral = new Vectoral({
  apiKey: process.env.VECTORAL_API_KEY,
  onError: (err, context) => logger.warn({ err, context }, "vectoral degraded"),
});

app.post("/api/signup", async (req, res) => {
  const { email, password, signals } = req.body;

  // The idempotency key must survive a retry, so it cannot be minted here — a
  // fresh UUID per invocation is a NEW key on the retry, which is exactly when
  // it must be the same one. Take it from the caller and upsert on it: a retry
  // finds the existing pending row and reuses its id.
  const key = req.get("idempotency-key");
  if (!key) return res.status(400).json({ error: "Idempotency-Key required" });

  const pending = await db.pendingSignups.upsert({
    where: { customerKey: key },
    create: { id: randomUUID(), customerKey: key, email },
  });

  const verdict = await vectoral.registrations.score({
    email,
    event_id: pending.id,
    ip: req.ip,                       // from your trusted proxy header
    user_agent: req.get("user-agent"),
    device_fingerprint: signals?.device_fingerprint,
    client: sanitizeClient(signals?.client),
    form: signals?.form,
    deadline_ms: 600,
  });

  await db.pendingSignups.update(pending.id, {
    registrationId: verdict.registration_id,
    tier: verdict.tier,
    score: verdict.score,
    reasons: verdict.reasons,
    degraded: verdict.degraded,       // log it — see below
  });

  if (verdict.tier >= RegistrationTier.StepUp) {
    return res.json({ action: "step_up" });
  }
  if (verdict.tier >= RegistrationTier.Challenge) {
    return res.json({ action: "captcha" });
  }

  const account = await createAccount({ email, password });
  await db.pendingSignups.update(pending.id, { accountId: account.id });
  // A degraded verdict has `registration_id: null` and `tier: 0`, so it reaches
  // here having passed both tier checks. There is nothing to link, and the `!`
  // assertion would be a compile-time fiction — guard at runtime instead.
  if (verdict.registration_id) {
    await vectoral.identity.linkRegistration(account.id, verdict.registration_id, {
      ip: req.ip,
      event_id: `signup-${account.id}`,
    });
  }

  res.json({ action: "allow" });
});

/** Never trust client-reported numbers verbatim. */
function sanitizeClient(client: unknown) {
  if (!client || typeof client !== "object") return undefined;
  const c = client as Record<string, unknown>;
  const anomaly = typeof c.fingerprint_anomaly === "number"
    ? Math.min(Math.max(c.fingerprint_anomaly, 0), 1)
    : undefined;
  return {
    ...(typeof c.webdriver === "boolean" ? { webdriver: c.webdriver } : {}),
    ...(anomaly !== undefined ? { fingerprint_anomaly: anomaly } : {}),
    ...(typeof c.timezone === "string" ? { timezone: c.timezone } : {}),
    ...(typeof c.load_to_submit_ms === "number"
      ? { load_to_submit_ms: c.load_to_submit_ms }
      : {}),
  };
}
```

Three things worth noticing:

- **`event_id` comes from the pending record**, so a retry after a lost response
  returns the original verdict instead of minting a second registration. It is
  also what enables the SDK's retries at all.
- **`verdict.degraded` is persisted.** Without it, a flow permanently allowing
  everything because the API key expired is indistinguishable from a flow where
  every signup is clean.
- **`sanitizeClient` clamps what the browser said.** Everything in `signals` is
  attacker-controlled.

## 3. When account creation is deferred

If you gate on email verification, the account does not exist yet. Store the
`registration_id` and link it whenever the account is finally created — hours or
days later is fine.

```ts
app.get("/verify/:token", async (req, res) => {
  const pending = await db.pendingSignups.findByToken(req.params.token);
  const account = await createAccount({ email: pending.email });

  if (pending.registrationId) {
    await vectoral.identity.linkRegistration(account.id, pending.registrationId, {
      event_id: `signup-${account.id}`,
    });
  }
  res.redirect("/welcome");
});
```

An unknown or already-linked id is ignored, never rejected, so a duplicate call
is harmless.

## 4. Closing the loop

When you eventually decide an account was fraudulent, say so. The label reaches
back through the registration link to the signup that created it.

```ts
await vectoral.labels.fraud(account.id, "chargeback 2026-09-14");
```

Label the good ones too, in bulk, on a schedule:

```ts
for (const account of await db.accounts.goodStandingFor({ months: 6 })) {
  await vectoral.labels.legitimate(account.id);
}
```

Without negatives, nothing learns where the boundary is.

## 5. Rolling it out safely

Steps 1–3 are safe to deploy immediately: during the warm-up window `tier` is
pinned to `0`, so the `action` branches never fire. Ship it, watch the logged
distribution, and only then start enforcing — top tier first. See
[registration screening](../../concepts/registration-screening.md#rolling-it-out).
