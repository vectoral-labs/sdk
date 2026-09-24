# Vectoral SDK documentation

## Concepts

Language-neutral. Read these once; they explain what the numbers mean and how to
deploy without breaking your own funnel.

| Page | What it covers |
| --- | --- |
| [Overview](concepts/overview.md) | The three questions Vectoral answers, and which call answers each |
| [Registration screening](concepts/registration-screening.md) | Scoring a signup before the account exists; tiers and rollout |
| [Inference scoring](concepts/inference-scoring.md) | The score → call → telemetry loop, and why the loop matters |
| [Fingerprinting](concepts/fingerprinting.md) | Device fingerprints and prompt fingerprints — two different things |
| [Salts](concepts/salts.md) | Which salt goes where, and what each one buys |
| [Failure and idempotency](concepts/reliability.md) | Fail-open, retries, and why `event_id` is not optional in practice |

## TypeScript

| Page | What it covers |
| --- | --- |
| [Quickstart](typescript/README.md) | Install, configure, first call |
| [Server SDK](typescript/server-sdk.md) | `@vectoral-labs/sdk` reference |
| [Browser SDK](typescript/browser-sdk.md) | `@vectoral-labs/browser` reference |
| [Recipe: signup flow](typescript/recipes/signup-flow.md) | End-to-end screening, browser through to label |
| [Recipe: inference flow](typescript/recipes/inference-flow.md) | Score, call the model, report the cost |

## Other languages

None yet. A Python SDK is the expected next one; it will live in `docs/python/`
and `python/`, mirroring this layout.
