# Changelog

Both packages are versioned together. Dates are ISO-8601.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project follows [Semantic Versioning](https://semver.org/) — with the usual
`0.x` caveat that minor bumps may break.

## [Unreleased]

### Added

- `@vectoral/browser`: standalone `<script>` build of the device fingerprint
  (`dist/vectoral-fingerprint.js`, also reachable as the `./standalone` export).
  Exposes `window.vectoralFp`, reads `data-site-key` off its own script tag, and
  produces the same salted value as the npm entry point. Posts nothing.
- Apache-2.0 license, CI, and package metadata required to publish.

### Changed

- `@vectoral/browser`: `signupSignals().client.webdriver` is now **optional**. It
  is present only when the browser actually reported `navigator.webdriver`;
  previously an unmeasured value was reported as a measured `false`.
- `@vectoral/sdk`: `deadline_ms` now raises the HTTP timeout as a floor rather
  than replacing it, so it can no longer reduce a `timeoutMs` you configured.
- `@vectoral/sdk`: an explicit `customerId` now wins over a `VECTORAL_API_KEY`
  found in the environment, instead of throwing "not both".

### Fixed

- `@vectoral/sdk`: the request timeout was cleared once response headers
  arrived, so a server that stalled mid-body hung the call indefinitely.
- `@vectoral/sdk`: scoring calls returned unvalidated 2xx bodies. A malformed
  response read as a clean verdict with `degraded` unset; it now degrades.
- `@vectoral/sdk`: `postCall`, `identity.record`, and `labels.submit` accepted
  any 2xx JSON as an acknowledgement, silently dropping writes.
- `@vectoral/sdk`: a throwing `onError` callback could reject a call that was
  supposed to fail open.
- `@vectoral/sdk`: `prepare()` silently overwrote a caller-supplied
  `prompt_fingerprint`, and never warned when `prompt_text_to_fingerprint` was
  passed with fingerprinting unconfigured.

## [0.1.0] — 2026-09-15

Initial prototype. Unpublished.
