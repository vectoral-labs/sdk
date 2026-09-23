import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The browser package's DOM collectors are tested against a stub `window`
    // installed per-test, not a full jsdom — keep the default node env.
    environment: "node",
    include: ["packages/*/src/**/*.test.ts"],
  },
});
