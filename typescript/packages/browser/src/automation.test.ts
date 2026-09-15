import { describe, it, expect, afterEach } from "vitest";
import { detectAutomation } from "./automation.js";
import { GlobalStubs, installCleanBrowser } from "./test-globals.js";

const stubs = new GlobalStubs();
const cleanBrowser = (over: Record<string, unknown> = {}): void =>
  installCleanBrowser(stubs, over);

afterEach(() => stubs.restore());

describe("detectAutomation", () => {
  it("scores a plausible browser at zero", () => {
    cleanBrowser();
    const r = detectAutomation();
    expect(r.score).toBe(0);
    expect(r.automated).toBe(false);
    expect(r.reasons).toEqual([]);
    expect(r.fingerprintAnomaly).toBe(0);
  });

  it("reports every tell it evaluated, not only the ones that fired", () => {
    cleanBrowser();
    const r = detectAutomation();
    expect(Object.keys(r.signals)).toContain("webdriver_flag");
    expect(r.signals["webdriver_flag"]).toBe(false);
  });

  it("catches the webdriver flag", () => {
    cleanBrowser({ webdriver: true });
    const r = detectAutomation();
    expect(r.automated).toBe(true);
    expect(r.reasons).toContain("webdriver_flag");
  });

  it("catches injected automation globals", () => {
    cleanBrowser();
    stubs.set("__playwright", {});
    expect(detectAutomation().reasons).toContain("automation_globals");
  });

  it("catches a headless user agent", () => {
    cleanBrowser({ userAgent: "Mozilla/5.0 HeadlessChrome/140.0.0.0" });
    expect(detectAutomation().reasons).toContain("headless_user_agent");
  });

  it("accumulates weak tells past the threshold via noisy-OR", () => {
    cleanBrowser();
    // Two mid-weight inconsistencies (0.4 each) — neither decisive alone.
    stubs.set("screen", { width: 0, height: 0, colorDepth: 0 });
    stubs.remove("chrome");
    const r = detectAutomation();
    expect(r.reasons).toEqual(
      expect.arrayContaining(["zero_screen", "chrome_object_missing"]),
    );
    expect(r.score).toBeGreaterThan(0.4);
    expect(r.score).toBeLessThan(0.8);
  });

  it("sorts reasons strongest first", () => {
    cleanBrowser({ webdriver: true, languages: [] });
    const r = detectAutomation();
    expect(r.reasons[0]).toBe("webdriver_flag");
    expect(r.reasons).toContain("empty_languages");
  });

  it("separates environment inconsistency from injected hooks", () => {
    cleanBrowser();
    // An injected global is not an inconsistency: it must not inflate the
    // anomaly score the server reads as `client.fingerprint_anomaly`.
    stubs.set("__puppeteer", {});
    const r = detectAutomation();
    expect(r.score).toBeGreaterThan(0.8);
    expect(r.fingerprintAnomaly).toBe(0);
  });

  it("flags a UA/platform contradiction", () => {
    cleanBrowser({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0",
      platform: "Linux x86_64",
    });
    const r = detectAutomation();
    expect(r.reasons).toContain("platform_ua_mismatch");
    expect(r.fingerprintAnomaly).toBeGreaterThan(0);
  });

  it("does not flag a consistent UA/platform pair", () => {
    cleanBrowser({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0",
      platform: "Win32",
    });
    expect(detectAutomation().signals["platform_ua_mismatch"]).toBe(false);
  });

  it("respects a custom threshold without changing the score", () => {
    cleanBrowser();
    stubs.set("screen", { width: 0, height: 0, colorDepth: 0 });
    const strict = detectAutomation({ threshold: 0.3 });
    const lax = detectAutomation({ threshold: 0.9 });
    expect(strict.score).toBe(lax.score);
    expect(strict.automated).toBe(true);
    expect(lax.automated).toBe(false);
  });

  it("survives a probe that throws", () => {
    cleanBrowser();
    stubs.set("navigator", {
      get userAgent(): string {
        throw new Error("hardened");
      },
    });
    expect(() => detectAutomation()).not.toThrow();
  });
});
