# Browser-side signals

Agent-facing instructions for collecting abuse signals **in the end user's
browser**. Optional, and independent of which server-side path the project uses —
read [`INSTALL.md`](INSTALL.md) first to pick that one
([`SERVERSIDE_TS.md`](SERVERSIDE_TS.md) or [`SERVERSIDE_API.md`](SERVERSIDE_API.md)).

Three ways to load browser-side collection. Two are the same npm package,
producing the same fingerprint; the third is the hosted sensor, which posts to
Vectoral directly and returns a token.

| Option | Served from | Posts to | Gives you |
| --- | --- | --- | --- |
| A — `@vectoral-labs/browser` (npm) | your bundle | your backend | fingerprint + automation tells + form telemetry |
| B — standalone `<script>` | your static host | your backend | fingerprint only |
| C — hosted sensor (CDN) | `cdn.vectoral.cloud` | **Vectoral** | behavioural telemetry + a signed `sensor_token` |

A and B never talk to Vectoral; C is the only one that does. Whichever you use,
the bot/human decision is made **server-side** — never enforce on a client value.

Whichever you pick, the only credential on the page is the publishable site key
(`pk_live_…`), which is meant to be readable in page source. **A secret key must
never appear here.**

## Option A — npm (a JavaScript frontend with a bundler)

```bash
npm install @vectoral-labs/browser
```

```js
import { trackForm, signupSignals } from "@vectoral-labs/browser";

const form = document.querySelector("#signup");
const emailInput = form.querySelector('input[name="email"]');

// Tracking starts on load, not at submit: the evidence is HOW the form was
// filled, which has already happened by the time submit fires.
const tracker = trackForm(form);

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const signals = await signupSignals({ siteKey: "pk_live_abc", form: tracker });
  await fetch("/api/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: emailInput.value, signals }),
  });
});
```

Zero dependencies, no Node builtins, side-effect-free import. `signupSignals()`
returns `device_fingerprint`, `client`, and `form` — which spread straight into
the score call — plus a `diagnostics` block that is for your logs only and is not
part of the wire contract.

## Option B — standalone `<script>` (no build step)

Fingerprint only. The file is `dist/vectoral-fingerprint.js` inside the package;
copy it out of `node_modules/@vectoral-labs/browser/dist/` and **host it
yourself** — it is not published to a CDN. ~4 KB minified, with a sourcemap
beside it.

```html
<script async src="/vectoral-fingerprint.js" data-site-key="pk_live_abc"></script>
<script>
  // Queue the call instead of assuming the async bundle has landed.
  window.vectoralFp = window.vectoralFp || { q: [] };
  window.vectoralFp.q.push(["get", null, (err, fp) => {
    if (!err) console.log(fp.fingerprint);
  }]);
</script>
```

| | |
| --- | --- |
| `data-site-key` | Required. Also accepted as `?siteKey=` on the script URL |
| `data-debug` | `"true"` adds raw `components` to the result. Debugging only |
| `window.vectoralFp.get()` | Resolves the fingerprint. Computes once, then reuses |
| `window.vectoralFp.version` | The API shape's version, not the fingerprint's |

This produces the **same salted value** as `deviceFingerprint()` for the same
site key, but only the fingerprint — not the automation tells or form telemetry.
Use it when the project has no build step; otherwise prefer npm.

## Option C — hosted sensor (CDN)

The sensor is a hosted script — the only option that talks to Vectoral directly.
It collects behavioural telemetry the package does not (pointer movement,
interaction timing, clicks, scrolls), posts it to `/v1/sensor/collect`, and hands
back a signed `sensor_token` your backend forwards to join the browser's verdict
to a score. It computes its own, **different** device fingerprint internally — do
not compare it with the `device_fingerprint` from A or B.

```html
<script async
  src="https://cdn.vectoral.cloud/v1/sensor.js?siteKey=pk_live_abc&endpoint=https://api.vectoral.cloud/v1/sensor/collect"></script>
```

| Parameter | Required | Description |
| --- | --- | --- |
| `siteKey` | yes | Your publishable `pk_live_…` key |
| `endpoint` | yes | The collect endpoint (`/v1/sensor/collect`) |
| `debug` | no | `1` logs signals to the console |

The same settings are accepted as `data-site-key`, `data-endpoint`, and
`data-debug="true"` attributes on the tag. **Without an `endpoint` the sensor
returns a local placeholder token and never contacts Vectoral** — so a missing
`endpoint` fails silently. Always set it.

Loading the script sends nothing, and it loads `async` — so queue the call
instead of assuming `window.vectoral` exists. The queue flushes as soon as the
script runs, whichever order the two land in. Call it right before the request
that triggers your LLM call:

```js
window.vectoral = window.vectoral || { q: [] };
window.vectoral.q.push(["getToken", { action: "generate" }, (err, token) => {
  if (!err) {
    // send `token` to your backend, which forwards it as request.sensor_token
  }
}]);
```

Once the script has loaded you can also `await window.vectoral.getToken(...)`
directly.

Fusion uses the most recent collect for the session within the last **5 minutes**,
so a session that never called `getToken()` has no browser signal to fuse.

**Forward the token, not just the session id.** Pass `request.sensor_token` on the
score call — it is signed, bound to your account, and short-lived (**about 2
minutes**), so it cannot be swapped onto another session the way a bare
`session_id` can, and it takes precedence over `session_id` for the join. An
invalid or expired token skips fusion rather than falling back, so forward it on
the next call or not at all. (The 5-minute figure above is the fusion window, not
the token lifetime — a token that has expired can no longer join.) If you cannot
use the token, forward `window.vectoral.sessionId` (e.g. as an `X-Vectoral-Session`
header) and pass it as `session_id` — but the sensor and the score call must use
the **same** session id or nothing joins.

For a real-time gate independent of the score call, verify the token server-side
with `/v1/sensor/verify`. Most integrations do not need it — the browser signal is
fused automatically via `request.sensor_token`.

## Guardrails

- **A and B: POST the output to your own backend, never to Vectoral.** Your
  backend adds the IP it observed and makes the score call.
- **C posts to Vectoral directly**, by design — but the join still happens on your
  backend, which forwards the token.
- `components` are raw probe values, **for debugging only — never send them
  anywhere**. They are withheld unless `data-debug="true"` is set.
- **Treat all of it as attacker-controlled.** Clamp `fingerprint_anomaly` to
  `[0,1]` and ignore absent fields rather than trusting the client. An attacker
  can strip the script or fake the posted values.
- `deviceFingerprint()` throws if `siteKey` is missing or there is no DOM.

## The trust boundary, in one line

Browser collects → posts to your backend (or, for C, to Vectoral) → your backend
adds the IP it observed → the score call → your policy acts on `tier`.

Everything the browser reports is spoofable; the one signal that is not — the
client IP — is only trustworthy when your own server observed it. Keep the
judgement on the server.

## Verify

- **A (npm):** `signupSignals()` resolves on a real page load and the payload
  reaches your endpoint.
- **B (script tag):** the fingerprint is stable across reloads and changes
  completely when `data-site-key` changes (the key is the salt).
- **C (sensor):** `window.vectoral.getToken()` resolves to a token (not the local
  placeholder — that means `endpoint` was missing), and the score response comes
  back with `signals_fused: true`.

## Where to read more

- [Browser sensor guide](https://docs.vectoral.com/guides/browser-sensor) — the hosted sensor, end to end
- [Signal fusion](https://docs.vectoral.com/guides/signal-fusion) — how the browser verdict joins a score
- [Browser SDK reference](docs/typescript/browser-sdk.md) — `@vectoral-labs/browser`
- [Fingerprinting](docs/concepts/fingerprinting.md) — which components are included, and which are deliberately not
- [Recipe: signup flow](docs/typescript/recipes/signup-flow.md) — browser through to label
