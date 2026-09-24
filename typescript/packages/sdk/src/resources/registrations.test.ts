import { describe, it, expect } from "vitest";
import { httpTimeoutFor } from "./registrations.js";

// The server clamps `deadline_ms` to [250, 6000]. These tests pin the property
// that matters — the local timeout never aborts a request the server is still
// working on — rather than the literal ceiling, which is what let the SDK and
// the server drift apart at 2000 vs 6000 without a single test going red.
const SERVER_DEADLINE_MIN_MS = 250;
const SERVER_DEADLINE_MAX_MS = 6000;

describe("httpTimeoutFor", () => {
  it("always leaves headroom above the server deadline", () => {
    for (const ms of [250, 400, 600, 2000, 4000, 6000]) {
      expect(httpTimeoutFor(ms)).toBeGreaterThan(ms);
    }
  });

  it("never aborts below the deadline the server will actually honour", () => {
    // The regression this file exists for: while the SDK clamped to 2000 and
    // the server honoured 6000, `deadline_ms: 5000` produced a 2300ms abort on
    // a request the server worked for 5s — a guaranteed fail-open zero.
    for (const ms of [3000, 5000, 6000]) {
      expect(httpTimeoutFor(ms)).toBeGreaterThan(ms);
    }
  });

  it("mirrors the server's clamp so an out-of-range value never surprises", () => {
    // A caller asking for 50ms would otherwise abort locally at 50ms while the
    // server worked for 250.
    expect(httpTimeoutFor(50)).toBe(httpTimeoutFor(SERVER_DEADLINE_MIN_MS));
    expect(httpTimeoutFor(60_000)).toBe(httpTimeoutFor(SERVER_DEADLINE_MAX_MS));
  });
});
