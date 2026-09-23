import { defineConfig } from "tsup";

// Browser target throughout: this package must never pull in a node builtin.
const shared = {
  target: "es2022",
  platform: "browser",
  sourcemap: true,
} as const;

// NOTE: `clean` is off in BOTH configs and the dist wipe lives in the `build`
// script instead. tsup runs an array of configs concurrently, so a `clean: true`
// on either one races the other's output — it happened to lose that race here,
// but only by a few milliseconds of scheduling luck.
export default defineConfig([
  // The npm entry: ESM + CJS for bundlers.
  {
    ...shared,
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: false,
    outExtension({ format }) {
      return { js: format === "cjs" ? ".cjs" : ".js" };
    },
  },
  // The standalone drop-in: one self-executing file for a plain <script> tag.
  // Minified because it ships over the wire to end users; the sourcemap beside
  // it keeps the build auditable.
  {
    ...shared,
    entry: { "vectoral-fingerprint": "src/standalone.entry.ts" },
    format: ["iife"],
    dts: false,
    clean: false,
    minify: true,
    outExtension() {
      return { js: ".js" };
    },
  },
]);
