import { describe, it, expect } from "vitest";
import { httpTimeoutFor } from "./registrations.js";

describe("httpTimeoutFor", () => {
  it("always leaves headroom above the server deadline", () => {
    expect(httpTimeoutFor(400)).toBeGreaterThan(400);
    expect(httpTimeoutFor(2000)).toBeGreaterThan(2000);
  });

  it("mirrors the server's clamp so an out-of-range value never surprises", () => {
    // The server clamps to [250, 2000]; a caller asking for 50ms would
    // otherwise abort locally at 50ms while the server worked for 250.
    expect(httpTimeoutFor(50)).toBe(httpTimeoutFor(250));
    expect(httpTimeoutFor(60_000)).toBe(httpTimeoutFor(2000));
  });
});
