# TypeScript quickstart

Two packages. Which one you need depends on where the code runs.

```bash
npm install @vectoral/sdk       # your server
npm install @vectoral/browser   # your signup/app pages
```

> **Prototype.** Both are `private` and unpublished. For now, consume them from
> the workspace at `typescript/packages/`.

## Server, in three lines

```ts
import { Vectoral } from "@vectoral/sdk";

const vectoral = new Vectoral({ apiKey: process.env.VECTORAL_API_KEY });

const verdict = await vectoral.registrations.score({ email, ip: req.ip });
```

`apiKey` falls back to `VECTORAL_API_KEY` and `baseUrl` to `VECTORAL_BASE_URL`,
so a typical app passes neither.

## Configuration

```ts
const vectoral = new Vectoral({
  apiKey: process.env.VECTORAL_API_KEY,   // or VECTORAL_API_KEY
  baseUrl: "https://api.vectoral.cloud",  // or VECTORAL_BASE_URL
  timeoutMs: 5000,
  retries: 2,                             // only for calls with an event_id
  failOpen: true,                         // scoring calls degrade, never throw
  onError: (err, context) => logger.warn({ err, context }, "vectoral degraded"),
  fingerprint: {                          // optional; see docs/concepts/salts.md
    enabled: true,
    salt: process.env.VECTORAL_FINGERPRINT_SALT,
    saltId: process.env.VECTORAL_FINGERPRINT_SALT_ID,
  },
});
```

Self-hosted deployments running in header auth mode pass `customerId` instead of
`apiKey`. Passing both throws.

### Environment variables

| Variable | Used for |
| --- | --- |
| `VECTORAL_API_KEY` | Secret API key (`vg_live_…`) |
| `VECTORAL_BASE_URL` | API base URL; defaults to the hosted endpoint |
| `VECTORAL_FINGERPRINT_SALT` | Secret tenant salt for prompt fingerprinting |
| `VECTORAL_FINGERPRINT_SALT_ID` | Generation label for that salt, e.g. `s_2026_09` |

## Browser, in three lines

```js
import { signupSignals, trackForm } from "@vectoral/browser";

const tracker = trackForm(document.querySelector("#signup"));
// at submit:
const signals = await signupSignals({ siteKey: "pk_live_abc", form: tracker });
```

POST `signals` to **your own** endpoint, never to Vectoral. Your backend spreads
it into the score call, where the IP it observed is added.

## Runtime support

- **`@vectoral/sdk`** — Node 18+, Deno, Bun, and edge runtimes. Needs a global
  `fetch`, or pass one via the `fetch` option. ESM and CJS builds ship.
- **`@vectoral/browser`** — any modern browser. No dependencies, no Node
  builtins, side-effect free. `deviceFingerprint()` prefers SubtleCrypto and
  falls back on insecure origins.

## Where to go next

- [Server SDK reference](server-sdk.md)
- [Browser SDK reference](browser-sdk.md)
- [Recipe: signup flow](recipes/signup-flow.md) — browser through to label
- [Recipe: inference flow](recipes/inference-flow.md)
- [Salts](../concepts/salts.md) — read before enabling prompt fingerprinting
