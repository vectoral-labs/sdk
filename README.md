# Vectoral SDKs

Client libraries for the [Vectoral](https://vectoral.cloud) fraud-scoring API —
screening signups before the account exists, scoring LLM inference traffic, and
collecting the browser-side signals that make both sharper.

## Layout

```
docs/                 all documentation
  concepts/           language-neutral: what the signals mean, how to roll out
  typescript/         TypeScript guides and API reference
typescript/           the TypeScript packages (npm workspace)
  packages/sdk/       @vectoral/sdk      — server-side
  packages/browser/   @vectoral/browser  — browser-side
scripts/              maintenance tooling
```

Documentation lives under `docs/`, never beside the code, so a reader following
a link never has to know which language they landed in. Each new language gets a
sibling folder in both trees: `docs/python/` alongside `python/`.

## Two packages, one trust boundary

| | `@vectoral/sdk` | `@vectoral/browser` |
| --- | --- | --- |
| Runs | on your server | in the end user's browser |
| Credential | secret API key (`vg_live_…`) | publishable site key (`pk_live_…`) |
| Talks to | Vectoral | **your** backend only |
| Holds secrets | yes | never |

The split is deliberate. Everything the browser reports is attacker-controlled,
and the one signal that is not — the client IP — is only trustworthy when your
own server observed it. The browser package collects; your backend judges and
forwards.

## Start here

- **New to Vectoral** → [`docs/concepts/overview.md`](docs/concepts/overview.md)
- **Screening signups** → [`docs/concepts/registration-screening.md`](docs/concepts/registration-screening.md)
- **Scoring inference traffic** → [`docs/concepts/inference-scoring.md`](docs/concepts/inference-scoring.md)
- **Choosing salts** → [`docs/concepts/salts.md`](docs/concepts/salts.md)
- **TypeScript quickstart** → [`docs/typescript/README.md`](docs/typescript/README.md)

## Status

Prototype. Both packages are `private` and unpublished; the API surface is
expected to move. The prompt-fingerprint implementation is a port of the
normative Go one and is verified against its golden vectors — see
[`docs/concepts/fingerprinting.md`](docs/concepts/fingerprinting.md).

## Development

```bash
cd typescript
npm install
npm test          # vitest, both packages
npm run typecheck
npm run build
```
