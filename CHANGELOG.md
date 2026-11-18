# Changelog

Both packages are versioned together. Dates are ISO-8601.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project follows [Semantic Versioning](https://semver.org/) — with the usual
`0.x` caveat that minor bumps may break.

## [Unreleased]

## [0.3.0]

`@vectoral-labs/sdk` catches up with the API: the Action Policy, account flags,
sanctions screening, the registration follow-up calls, and webhooks. Everything
is additive. No method or field from 0.2.0 was renamed, removed or retyped.
`@vectoral-labs/browser` has no changes and moves to 0.3.0 because both packages
share a version.

### Added

- `inference.score()` returns `action`, `action_reason` and `policy_action`
  when the Action Policy is on for your organisation, and `account` (the flag
  state: `flag_level`, `flag_reasons`, `flag_id`, `flag_since`, `flag_set_by`)
  when account flags are on. The request accepts `request.asn` and
  `request.ip_country`.
- `registrations.score()` returns the whole verdict. 0.2.0 rebuilt it field by
  field and dropped `action`, `action_reason`, `policy_action`,
  `step_up_fails` and `screening`; they now come through, along with any field
  the API adds later. The API's `degraded` list arrives as `degraded_facts`,
  because `degraded` already means "the SDK failed open" and keeps that
  meaning. The request accepts `identity` for sanctions screening.
- `registrations.get()`, `reportStepUp()`, `label()`, `getScreening()`,
  `createClearance()` and `revokeClearance()`, for `GET /v1/registrations/{id}`,
  `POST …/step-up`, `POST …/label`, `GET …/screening`, and `POST`/`DELETE
  …/screening/clearances`.
- `labels.submit()` accepts `event_id`, `flag_id`, `reason_code` and
  `cleared_reasons`, and returns `flag` when the label settled a flag.
  `fraud()` and `legitimate()` take the same fields as a third argument.
- `sensor.verify()` for `POST /v1/sensor/verify`, with an optional `action`.
  Servers that check it refuse a token minted for another action with a 400
  (`token action mismatch`).
- `flags.list()`, `flags.iterate()` (follows `next_cursor`) and `flags.get()`.
- `accounts.list()`, `get()`, `scores()`, `setContext()`, `recordCommerce()`
  and `stats()`.
- `imports.send()` and `imports.get()` for `POST /v1/import` and its status;
  `data.status()` and `data.integrationStatus()`.
- `verifyWebhookSignature()`, `parseWebhook()` and `signWebhookPayload()` for
  the `x-vectoral-signature` scheme, tested against vectors produced by the
  server's own signer. Typed envelopes for every webhook event, and
  `isWebhookEvent()` to narrow one.
- Types for the open value sets (`Action`, `ActionReason`, `FlagLevel`,
  `FlagReason`, `SensorDecision` and the rest). Each includes `string`, so a
  value added to the API later type-checks and passes through untouched.

### Changed

- Reads (`GET`) and `sensor.verify()` are retried on transient failures. Writes
  keep the 0.2.0 rule: retried only with an `event_id`. That now covers
  `labels.submit()` with an `event_id`, `accounts.recordCommerce()` and
  `imports.send()`. `inference.score()` is still never retried.
- `registrations.score()` with `deadline_ms` keeps its HTTP timeout at least
  1,000 ms above the deadline, up from 300. The server's domain rules and save
  run outside `deadline_ms` and can take about 750 ms, so the old margin could
  abort a signup the server was about to answer.

### Fixed

- The `ReasonCode` comment said the browser reason codes come from
  `@vectoral-labs/browser`. They come from the CDN browser sensor's token.

## [0.2.0] — 2026-09-25

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
