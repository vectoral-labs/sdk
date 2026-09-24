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

`0.x`. Both packages publish under the **`beta`** dist-tag, so `npm install
@vectoral-labs/sdk` will not pick them up as `latest` — ask for `@beta` explicitly.
The API surface is expected to move.

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
publishing** — OIDC, no `NPM_TOKEN` anywhere in the repo or its secrets.

```bash
cd typescript
npm version <patch|minor|major> --workspaces --include-workspace-root
cd .. && git push && git push --tags      # a v* tag triggers the release
```

`.github/workflows/release.yml` re-runs the tests, refuses to publish if the tag
disagrees with `package.json`, and publishes both packages. npm generates a
provenance attestation automatically, so every tarball is cryptographically
tied to the commit and workflow that produced it.

`--dry-run` is available through the Actions tab (`workflow_dispatch`) if you
want to rehearse without publishing.

`dist/` is gitignored, so `prepublishOnly` is what guarantees the tarball holds
fresh bytes.

### One-time setup

Trusted publishing is configured per package at **npmjs.com → package →
Settings → Trusted Publisher**:

| Field | Value |
| --- | --- |
| Organization or user | `vectoral-labs` |
| Repository | `sdk` |
| Workflow filename | `release.yml` |
| Environment | leave blank |

The workflow **filename** is part of what npm trusts, so renaming or moving
`release.yml` breaks publishing until the config is updated to match.

npm's docs describe adding a trusted publisher from an existing package's
settings page, which implies the very first publish of a brand-new package name
still needs a manual, authenticated `npm publish`. Check the npm UI when you get
there — if the setting is available before the first publish, skip the manual
step entirely.

## Development

```bash
cd typescript
npm install
npm test          # vitest, both packages
npm run typecheck
npm run build
```
