# `@vectoral/browser` reference

Browser-side signal collection. Zero dependencies, and it **never talks to
Vectoral** — post its output to your own backend.

The only credential it takes is your publishable site key, which salts the
device fingerprint. Never put a secret here; see [salts](../concepts/salts.md).

Two ways to load it, both producing the same values:

- **npm**, for anything with a bundler. The `import` entry is side-effect free.
  Everything below describes this.
- **[a standalone `<script>` tag](#standalone-build--no-bundler)**, for sites
  without a build step. Fingerprint only.

## `signupSignals(options) → Promise<SignupSignals>`

The one call a signup page needs. Runs the fingerprint, the automation tells,
and the form snapshot, and returns them already shaped for the registration
endpoint.

```js
import { trackForm, signupSignals } from "@vectoral/browser";

const tracker = trackForm(document.querySelector("#signup"));

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

```js
{
  device_fingerprint: "fp_9c1e4a7b…",
  client: {
    webdriver: false,          // present only when the browser reported it
    fingerprint_anomaly: 0.0,
    load_to_submit_ms: 8400,
    timezone: "Europe/Berlin",
  },
  form: { load_to_submit_ms: 8400, fields: { email: { … } } },
  diagnostics: {               // for YOUR logs; not part of the wire contract
    automation_score: 0.0,
    automation_reasons: [],
    fingerprint_strong: true,
    fingerprint_coverage: { present: 11, total: 13 },
  },
}
```

`client` and `form` can be spread straight into `registrations.score()`.
`diagnostics` is yours to log.

| Option | Notes |
| --- | --- |
| `siteKey` | Required. Your publishable `pk_live_…` key |
| `form` | A tracker from `trackForm()`, if you wired one up |
| `automationThreshold` | Only affects `automated`; never the score |

## `deviceFingerprint(options) → Promise<DeviceFingerprint>`

```js
const { fingerprint, strong, coverage, components } = await deviceFingerprint({
  siteKey: "pk_live_abc",
});
```

Async (canvas, WebGL, and SubtleCrypto all are). Call once per page and reuse —
it does not change within a session.

| Field | Notes |
| --- | --- |
| `fingerprint` | `fp_` + 32 hex chars. Send as `device_fingerprint` |
| `strong` | `false` means an insecure context forced a non-crypto fallback hash |
| `coverage` | `{ present, total }` components. A low count is itself a signal |
| `components` | Raw values, **for debugging only — never send these anywhere** |

Throws if `siteKey` is missing or there is no DOM. Individual probes that throw
cost you that one component, not the fingerprint.

See [fingerprinting](../concepts/fingerprinting.md) for which components are
included and, more importantly, which are deliberately left out.

## `detectAutomation(options?) → AutomationResult`

Synchronous and cheap. Safe to call on every protected action, not just signup.

```js
const auto = detectAutomation({ threshold: 0.6 });
// { score: 0.87, automated: true, reasons: ["webdriver_flag", …],
//   signals: { … }, fingerprintAnomaly: 0.0 }
```

| Field | Notes |
| --- | --- |
| `score` | Noisy-OR of the weights that fired, `[0,1]` |
| `automated` | `score >= threshold` (default `0.6`) |
| `reasons` | Tells that fired, strongest first |
| `signals` | **Every** tell evaluated, fired or not |
| `fingerprintAnomaly` | The environment-inconsistency subscore — send as `client.fingerprint_anomaly` |

### The tells

| Tell | Weight | Catches |
| --- | --- | --- |
| `webdriver_flag` | 0.85 | `navigator.webdriver` |
| `automation_globals` | 0.85 | Puppeteer / Playwright / Selenium / PhantomJS globals |
| `chromedriver_cdc` | 0.85 | chromedriver's `$cdc_…` properties |
| `headless_user_agent` | 0.8 | `Headless` in the UA |
| `empty_languages` | 0.55 | empty `navigator.languages` |
| `zero_outer_window` | 0.5 | `outerWidth/Height === 0` |
| `native_code_patched` | 0.45 | stealth plugins rewriting native functions |
| `webgl_software_renderer` | 0.45 | SwiftShader / llvmpipe — headless or VM |
| `chrome_object_missing` | 0.4 | Chrome UA with no `window.chrome` |
| `zero_screen` | 0.4 | `screen.width/height === 0` |
| `platform_ua_mismatch` | 0.35 | UA OS ≠ `navigator.platform` |

Signals combine with noisy-OR (`1 - Π(1-w)`): one strong tell dominates, several
weak ones still accumulate.

### Why `fingerprintAnomaly` is not just `score`

`score` includes injected globals — evidence that automation is present.
`fingerprintAnomaly` counts only the tells where the **browser contradicts
itself**: a Windows UA on a Linux platform, a zero-sized screen, a software
renderer. That is what `client.fingerprint_anomaly` means server-side, so an
injected `__puppeteer` global raises the score without touching the anomaly.

### Trust model

This runs on the abuser's machine.

- **Stealth frameworks** (`puppeteer-extra-stealth`, `undetected-chromedriver`)
  patch most of these tells. `native_code_patched` catches the *patching itself*,
  but it is an arms race — expect sophisticated bots to score low.
- An attacker can strip the script or fake the posted score outright.

Treat the output as a **soft signal that raises suspicion** — strongest when
several independent tells fire together — never as a standalone block. The
spoof-resistant signals live server-side: IP classification, token velocity from
real telemetry, sybil clustering. Let those carry the weight.

Always sanity-check what arrives at your backend: clamp `fingerprint_anomaly` to
`[0,1]` and ignore absent fields rather than trusting the client blindly.

## `trackForm(form, options?) → FormTracker`

```js
const tracker = trackForm(document.querySelector("#signup"), {
  fields: ["email", "password"],   // optional allowlist
});

tracker.snapshot();  // call at submit
tracker.stop();      // detach; idempotent
```

Listeners are passive and capturing, so they never block typing. Fields are
named by `name`, then `id`, then `type`.

**Buttons are not fields.** Anything whose `type` is `submit`, `button`, `reset`
or `image` is skipped, so it never reaches `fields` — including the submit button
itself, which takes focus when clicked and, having no `name` or `id`, would
otherwise fall through the naming chain and report itself as a field called
`"submit"` with zero keystrokes. An `<input name="submit">` is a text field and
is still tracked.

Pass `fields` when you want to be explicit about what is reported rather than
relying on that.

**Only names and counts are recorded — never values.**

```js
{
  load_to_submit_ms: 8400,
  fields: {
    email:    { pasted: false, keystrokes: 22, corrections: 2, focus_ms: 3100 },
    password: { pasted: true,  keystrokes: 0,  corrections: 0, focus_ms: 400 },
  },
}
```

- `pasted` — the valuable bit: scripted fills paste, humans type. Set by both
  `paste` events and `insertFromPaste` input events.
- `corrections` — backspaces and deletes. Humans make them; scripts do not.
- `keystrokes` — character-producing keys only; modifiers and arrows do not
  count.
- `focus_ms` — accumulated across visits. `snapshot()` includes in-progress
  focus without ending it, so calling it twice is safe.

`FormTelemetry` is exported for driving the same accounting from a framework
that does not hand you a DOM node.

## Standalone build — no bundler

`dist/vectoral-fingerprint.js` is a single self-executing file for sites that
cannot `npm install` anything. It computes **the same fingerprint** as
`deviceFingerprint()` — same salted SHA-256, same components, same value — and
like the rest of this package it posts nothing anywhere.

```html
<script
  async
  src="/vectoral-fingerprint.js"
  data-site-key="pk_live_abc"
></script>
```

```js
const { fingerprint, strong, coverage } = await window.vectoralFp.get();
// fp_9c1e4a7b… — identical to what the npm entry returns for this site key
```

Host the file yourself; it is not published to a CDN. ~4 KB minified, with a
sourcemap beside it so the served bytes stay auditable.

| | |
| --- | --- |
| `data-site-key` | Required. Also accepted as `?siteKey=` on the script URL |
| `data-debug` | `"true"` adds `components` to the result. Debugging only |
| `window.vectoralFp.get()` | Resolves the fingerprint. Computes once, then reuses |
| `window.vectoralFp.version` | The API shape's version, not the fingerprint's |

`components` is **withheld unless you ask for it**. A global on a live page puts
raw probe values one `JSON.stringify` away from being posted somewhere they
should not go.

### Loading it `async`

Load order is not knowable with `async`, so queue the call instead of assuming
the bundle has landed:

```html
<script>
  window.vectoralFp = window.vectoralFp || { q: [] };
  vectoralFp.q.push(["get", null, (err, fp) => {
    if (!err) console.log(fp.fingerprint);
  }]);
</script>
```

This works whichever order the two scripts run in — `q.push` executes
immediately once the bundle is present. Loading synchronously instead? Just call
`window.vectoralFp.get()`.

### Why the global is `vectoralFp`

The hosted sensor (below) assigns `window.vectoral` outright rather than merging
into it, so sharing that name would let load order decide which script survives.
A separate global lets both run on the same page.

See [`examples/fingerprint-standalone.html`](../../typescript/examples/fingerprint-standalone.html).

## Not in this package

The hosted browser sensor (`cdn.vectoral.cloud/v1/sensor.js`) posts to Vectoral
directly and returns a signed `sensor_token`, which your backend forwards to
join the browser's bot verdict to a score. That is the difference that matters —
**transport, not packaging**: everything here reports to *your* backend and
talks to Vectoral never, whether you load it from npm or from a script tag.

The sensor is the only path to a `sensor_token`, and it carries behavioural
telemetry (pointer movement, interaction timing) that this package does not
collect. The two are complementary inputs to the same registration call, not
alternatives — pass `device_fingerprint` from here and `sensor_token` from
there.

Note that the sensor computes its own, **different** device fingerprint
internally. Do not compare the two values; they are not the same function.
