import { describe, it, expect } from "vitest";
import { httpTimeoutFor } from "./registrations.js";

// The server clamps `deadline_ms` to [250, 6000]. These tests pin the property
// that matters — the local timeout never aborts a request the server is still
// working on — because pinning the literal ceiling is what let the SDK and the
// server drift to 2000 vs 6000 with the suite still green.
const SERVER_DEADLINE_MIN_MS = 250;
const SERVER_DEADLINE_MAX_MS = 6000;

describe("httpTimeoutFor", () => {
  it("never aborts below a deadline the server will honour", () => {
    // 3000 and above are the regression: while the SDK clamped to 2000,
    // `deadline_ms: 5000` produced a 2300ms abort on a request the server
    // worked 5s on — a guaranteed fail-open zero.
    for (const ms of [250, 400, 600, 2000, 3000, 5000, 6000]) {
      expect(httpTimeoutFor(ms)).toBeGreaterThan(ms);
    }
  });

  it("clamps a too-small deadline up to the server's floor", () => {
    // A caller asking for 50ms would otherwise abort locally at 50ms while the
    // server worked for 250.
    expect(httpTimeoutFor(50)).toBe(httpTimeoutFor(SERVER_DEADLINE_MIN_MS));
  });

  it("clamps a too-large deadline down to the server's ceiling", () => {
    // Asserted as a value rather than against httpTimeoutFor(6000), which is
    // trivially true for any ceiling at or below 6000 and so would pass while
    // the SDK clamped low — the exact bug this file failed to catch before.
    expect(httpTimeoutFor(60_000)).toBeGreaterThan(SERVER_DEADLINE_MAX_MS);
  });
});
