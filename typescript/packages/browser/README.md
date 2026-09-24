# `@vectoral-labs/browser`

Browser-side signal collection for [Vectoral](https://vectoral.cloud): device
fingerprint, automation tells, and form-fill telemetry.

Zero dependencies. Holds no secrets, and **never talks to Vectoral** — it hands
values to your page, and your backend forwards them.

```bash
npm install @vectoral-labs/browser@beta
```

```js
import { trackForm, signupSignals } from "@vectoral-labs/browser";

const tracker = trackForm(document.querySelector("#signup"));

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const signals = await signupSignals({ siteKey: "pk_live_abc", form: tracker });
  await fetch("/api/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: emailInput.value, signals }),
  });
});
```

No bundler? The device fingerprint also ships as a standalone script tag:

```html
<!-- You host this file. Point src at wherever you serve it from. -->
<script async src="/path/to/vectoral-fingerprint.js" data-site-key="pk_live_abc"></script>
<script>
  window.vectoralFp = window.vectoralFp || { q: [] };
  vectoralFp.q.push(["get", null, (err, fp) => console.log(fp.fingerprint)]);
</script>
```

The file is `dist/vectoral-fingerprint.js` in this package — host it yourself.

## Documentation

- [Browser SDK reference](https://github.com/vectoral-labs/sdk/blob/main/docs/typescript/browser-sdk.md)
- [What the signals mean](https://github.com/vectoral-labs/sdk/blob/main/docs/concepts/fingerprinting.md)
- Server-side counterpart: [`@vectoral-labs/sdk`](https://www.npmjs.com/package/@vectoral-labs/sdk)

## Status

`0.x`, published under the `beta` tag. The API surface may still move.

## License

Apache-2.0
