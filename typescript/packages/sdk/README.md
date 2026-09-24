# `@vectoral-labs/sdk`

Server-side SDK for the [Vectoral](https://vectoral.cloud) fraud-scoring API.

**Server-side only.** It carries a secret API key, and the client IP it sends is
only meaningful when your own server observed it. Browser-side collection lives
in [`@vectoral-labs/browser`](https://www.npmjs.com/package/@vectoral-labs/browser).

```bash
npm install @vectoral-labs/sdk@beta
```

```ts
import { Vectoral } from "@vectoral-labs/sdk";

const vectoral = new Vectoral({
  apiKey: process.env.VECTORAL_API_KEY,
  onError: (err, context) => logger.warn({ err, context }, "vectoral degraded"),
});

const verdict = await vectoral.inference.score({
  account_id: "user_abc123",
  request: { ip: req.ip, model_requested: "claude-opus-5" },
});

if (verdict.score > 0.7) return rateLimit();
```

Scoring calls **fail open**: a network failure returns a clean verdict with
`degraded: true` rather than throwing, so a fraud check can never take down the
flow it protects. Check `degraded` — a flow silently running at zero because of
an expired key looks exactly like a flow where every request is legitimate.

## Documentation

- [Server SDK reference](https://github.com/vectoral-labs/sdk/blob/main/docs/typescript/server-sdk.md)
- [Failure and idempotency](https://github.com/vectoral-labs/sdk/blob/main/docs/concepts/reliability.md)
- [Choosing salts](https://github.com/vectoral-labs/sdk/blob/main/docs/concepts/salts.md)

## Status

`0.x`, published under the `beta` tag. The API surface may still move.

## License

Apache-2.0
