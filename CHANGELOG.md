# Changelog

Both packages are versioned together. Dates are ISO-8601.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project follows [Semantic Versioning](https://semver.org/) — with the usual
`0.x` caveat that minor bumps may break.

## [Unreleased]

### Added

- `@vectoral-labs/browser`: standalone `<script>` build of the device fingerprint
  (`dist/vectoral-fingerprint.js`, also reachable as the `./standalone` export).
  Exposes `window.vectoralFp`, reads `data-site-key` off its own script tag, and
  produces the same salted value as the npm entry point. Posts nothing.
- Apache-2.0 license, CI, and package metadata required to publish.
- Release workflow using npm trusted publishing (OIDC). No `NPM_TOKEN` exists in
  the repository or its secrets; provenance attestations are generated
  automatically, tying each tarball to the commit and workflow that built it.

### Changed

- **Minimum Node is now 20.** It was declared as 18, but the test toolchain
  never ran there: vitest 4 pulls in rolldown, which imports `styleText` from
  `node:util` — added in Node 20.12 and absent from every 18.x. Node 18 reached
  end of life on 2025-04-30, so the floor moves rather than the toolchain.
- `@vectoral-labs/browser`: `signupSignals().client.webdriver` is now **optional**. It
  is present only when the browser actually reported `navigator.webdriver`;
  previously an unmeasured value was reported as a measured `false`.
- `@vectoral-labs/sdk`: `deadline_ms` now raises the HTTP timeout as a floor rather
  than replacing it, so it can no longer reduce a `timeoutMs` you configured.
- `@vectoral-labs/sdk`: an explicit `customerId` now wins over a `VECTORAL_API_KEY`
  found in the environment, instead of throwing "not both".

### Fixed

- `@vectoral-labs/sdk`: the request timeout was cleared once response headers
  arrived, so a server that stalled mid-body hung the call indefinitely.
- `@vectoral-labs/sdk`: scoring calls returned unvalidated 2xx bodies. A malformed
  response read as a clean verdict with `degraded` unset; it now degrades.
- `@vectoral-labs/sdk`: `postCall`, `identity.record`, and `labels.submit` accepted
  any 2xx JSON as an acknowledgement, silently dropping writes.
- `@vectoral-labs/sdk`: a throwing `onError` callback could reject a call that was
  supposed to fail open.
- `@vectoral-labs/sdk`: `prepare()` silently overwrote a caller-supplied
  `prompt_fingerprint`, and never warned when `prompt_text_to_fingerprint` was
  passed with fingerprinting unconfigured.

## [0.1.0] — 2026-09-15

Initial prototype. Unpublished.
