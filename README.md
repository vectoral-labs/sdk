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
  packages/sdk/       @vectoral-labs/sdk      — server-side
  packages/browser/   @vectoral-labs/browser  — browser-side
scripts/              maintenance tooling
```

Documentation lives under `docs/`, never beside the code, so a reader following
a link never has to know which language they landed in. Each new language gets a
sibling folder in both trees: `docs/python/` alongside `python/`.

## Two packages, one trust boundary

| | `@vectoral-labs/sdk` | `@vectoral-labs/browser` |
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

`0.x`, published to `latest`. The API surface is expected to move, so pin an
exact version if you need stability across releases.

The prompt-fingerprint implementation is a port of the normative Go one and is
verified against its golden vectors — see
[`docs/concepts/fingerprinting.md`](docs/concepts/fingerprinting.md).

### Endpoint coverage

Every endpoint the SDK calls is live on the deployed API, including
`POST /v1/registrations/score`.

Not yet wrapped by the SDK: `POST /v1/registrations/{id}/label` (registration-level
labels, distinct from the account labels `vectoral.labels` covers),
`POST /v1/accounts/{id}/commerce`, and the import/status endpoints.

## Releasing

CI gates every PR on tests, typecheck, build, and a full consumer install of
both tarballs. Publishing happens in GitHub Actions via npm **trusted
publishing** — OIDC, no `NPM_TOKEN` anywhere in the repo or its secrets, and a
provenance attestation on every tarball tying it to the commit and workflow that
produced it.

The procedure, the trusted-publisher settings, and the traps — a `v*` tag
publishes with no approval gate, npm ignores `publishConfig.tag` so the dist-tag
must be explicit, and a 404 at publish time means three different things — are
in [`AGENTS.md`](AGENTS.md#releasing).

Kept in one place deliberately: this section and that one drifted apart twice
while the repo was young, most recently over a version-bump flag that silently
wrote a version into a package that is never published.

## Development

```bash
cd typescript
npm install
npm test          # vitest, both packages
npm run typecheck
npm run build
```
