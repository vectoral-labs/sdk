# Installing Vectoral

Agent-facing instructions for adding Vectoral to a project. Pick from the project
you are in, then read exactly one of the server-side files — they are two ways to
do the same thing, and mixing them is a mistake. Browser-side collection is
separate and optional.

| The project you are in | Read |
| --- | --- |
| TypeScript or JavaScript — a `package.json`, a bundler, and a runtime of Node 20+, Deno, Bun, or an edge runtime | **[`SERVERSIDE_TS.md`](SERVERSIDE_TS.md)** — the npm packages |
| Anything else: Python, Go, Ruby, PHP, Java, a serverless function you cannot add npm packages to, or any stack with no JavaScript toolchain | **[`SERVERSIDE_API.md`](SERVERSIDE_API.md)** — the HTTP API by hand |

Both call the same endpoints with the same secret key and return the same
verdicts. The TypeScript path adds typed helpers, in-process prompt
fingerprinting, fail-open handling, and automatic retries on the calls that are
safe to repeat; the API path is the same integration written by hand, in whatever
language the project already uses.

Both paths talk to **your deployment's endpoint** — the hosted
`https://api.vectoral.cloud` unless you self-host, run in your own VPC, or serve a
custom domain. Your Vectoral dashboard shows the exact base URL: substitute it
wherever a snippet shows the hosted default.

If the project also has a signup or app page in a browser, read
**[`BROWSER.md`](BROWSER.md)**. It is optional, works with either server-side
path, and the standalone `<script>` there needs no build step.
