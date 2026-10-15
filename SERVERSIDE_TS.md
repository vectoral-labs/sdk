# Server-side integration — TypeScript

Agent-facing instructions for adding Vectoral to a **TypeScript or JavaScript**
project. If the project has no JavaScript toolchain — Python, Go, Ruby, PHP,
Java, or a serverless function you cannot add npm packages to — read
[`SERVERSIDE_API.md`](SERVERSIDE_API.md) instead.

This file is the **server** half: `@vectoral-labs/sdk`. Browser-side collection
is a separate package and lives in [`BROWSER.md`](BROWSER.md).

```bash
npm install @vectoral-labs/sdk
```

- Runs on Node 20+, Deno, Bun, and edge runtimes. Needs a global `fetch`, or pass
  one via the `fetch` option.
- Ships ESM and CJS builds.
- `0.x`, published to `latest`. A plain install works; **pin an exact version**
  if the project needs stability across releases.

Wire it up once, at module scope, and reuse the instance:

```ts
import { Vectoral, RegistrationTier } from "@vectoral-labs/sdk";

const vectoral = new Vectoral({
  apiKey: process.env.VECTORAL_API_KEY,
  onError: (err, context) => logger.warn({ err, context }, "vectoral degraded"),
});

const verdict = await vectoral.registrations.score({
  email,
  ip: req.ip,                 // the IP YOUR server observed
  event_id: pendingSignup.id, // idempotency; also enables retries
});

if (verdict.tier >= RegistrationTier.StepUp) return requireStepUp();
```

`apiKey` falls back to `VECTORAL_API_KEY` and `baseUrl` to `VECTORAL_BASE_URL`,
so a typical app passes neither. The constructor throws `VectoralConfigError`
for a missing credential, both credentials, or no `fetch`.

| Variable | Used for |
| --- | --- |
| `VECTORAL_API_KEY` | Secret API key (`vg_live_…`) |
| `VECTORAL_BASE_URL` | API base URL; defaults to the hosted endpoint |
| `VECTORAL_FINGERPRINT_SALT` | Secret tenant salt for prompt fingerprinting |
| `VECTORAL_FINGERPRINT_SALT_ID` | Generation label for that salt, e.g. `s_2026_09` |

The SDK wraps the same endpoints as [`SERVERSIDE_API.md`](SERVERSIDE_API.md) —
`registrations.score()`, `inference.score()`, `inference.postCall()`,
`identity.record()` — and adds fail-open handling and in-process prompt
fingerprinting. It also retries transient failures for you, but **only on
`registrations.score()`, `inference.postCall()`, and `identity.record()`**, and
only when the call carries an `event_id`. **`inference.score()` is the
exception** — it never retries, even with an `event_id`.

## Guardrails

- **Scoring calls fail open.** A network failure returns a clean verdict with
  `degraded: true` rather than throwing. Check `degraded` — a flow silently
  running at zero because of an expired key looks exactly like one where every
  request is legitimate. Wire up `onError` so the failure is visible.
- **`postCall` never fails open.** Handle or queue its errors; a transient
  failure belongs on a retry queue, not in a swallowed `catch`.
- **Pass `event_id`** for anything that may be retried. Automatic retries apply
  only to `registrations.score()`, `inference.postCall()`, and
  `identity.record()`, and only when the call carries one. `inference.score()`
  never retries, so handle its failure yourself.
- `ip` must be the address your own server observed. It is meaningless when
  forwarded from the client.
- Self-hosted deployments in header-auth mode pass `customerId` instead of
  `apiKey`. Passing both throws.

## Verify

- The import resolves and the project's own build/typecheck passes.
- A call made with a deliberately bad key returns `degraded: true`, not a thrown
  error, while `postCall` with the same key *does* throw.

## Where to read more

- [TypeScript quickstart](docs/typescript/README.md) — install, configure, first call
- [Server SDK reference](docs/typescript/server-sdk.md) — `@vectoral-labs/sdk`
- [Inference scoring](docs/concepts/inference-scoring.md) — the score → call → telemetry loop
- [Registration screening](docs/concepts/registration-screening.md) — scoring a signup before the account exists
- [Recipe: signup flow](docs/typescript/recipes/signup-flow.md) — browser through to label
- [Recipe: inference flow](docs/typescript/recipes/inference-flow.md)
- [Salts](docs/concepts/salts.md) — read before enabling prompt fingerprinting
