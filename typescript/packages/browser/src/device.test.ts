import { describe, it, expect, afterEach } from "vitest";
import { deviceFingerprint } from "./device.js";
import { GlobalStubs, installCleanBrowser } from "./test-globals.js";

const stubs = new GlobalStubs();
const browser = (over: Record<string, unknown> = {}): void =>
  installCleanBrowser(stubs, over);

afterEach(() => stubs.restore());

describe("deviceFingerprint", () => {
  it("requires a site key — it is the salt", async () => {
    browser();
    await expect(
      deviceFingerprint({ siteKey: "" } as { siteKey: string }),
    ).rejects.toThrow(/siteKey/);
  });

  it("refuses to run outside a browser", async () => {
    stubs.remove("document");
    await expect(deviceFingerprint({ siteKey: "pk_live_a" })).rejects.toThrow(/DOM/);
  });

  it("is stable across calls on the same device", async () => {
    browser();
    const a = await deviceFingerprint({ siteKey: "pk_live_a" });
    const b = await deviceFingerprint({ siteKey: "pk_live_a" });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).toMatch(/^fp_[0-9a-f]{32}$/);
  });

  it("is scoped per tenant: the same device differs across site keys", async () => {
    browser();
    const a = await deviceFingerprint({ siteKey: "pk_live_a" });
    const b = await deviceFingerprint({ siteKey: "pk_live_b" });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it("changes when the device changes", async () => {
    browser();
    const before = await deviceFingerprint({ siteKey: "pk_live_a" });
    stubs.set("screen", { width: 1280, height: 720, colorDepth: 24 });
    const after = await deviceFingerprint({ siteKey: "pk_live_a" });
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it("ignores the browser version so an update does not reset the value", async () => {
    const withVersion = (v: string): Record<string, unknown> => ({
      userAgentData: {
        platform: "macOS",
        mobile: false,
        brands: [
          { brand: "Chromium", version: v },
          { brand: "Not.A/Brand", version: "24" },
        ],
      },
    });
    browser(withVersion("140"));
    const before = await deviceFingerprint({ siteKey: "pk_live_a" });
    browser(withVersion("141"));
    const after = await deviceFingerprint({ siteKey: "pk_live_a" });
    expect(after.fingerprint).toBe(before.fingerprint);
  });

  it("reports coverage so a hardened browser is visible", async () => {
    browser();
    const full = await deviceFingerprint({ siteKey: "pk_live_a" });
    expect(full.coverage.present).toBeGreaterThan(0);
    expect(full.coverage.present).toBeLessThanOrEqual(full.coverage.total);

    stubs.set("navigator", {});
    stubs.set("screen", { width: 0, height: 0, colorDepth: 0 });
    const bare = await deviceFingerprint({ siteKey: "pk_live_a" });
    expect(bare.coverage.present).toBeLessThan(full.coverage.present);
    expect(bare.coverage.total).toBe(full.coverage.total);
  });

  it("marks SubtleCrypto digests as strong", async () => {
    browser();
    const fp = await deviceFingerprint({ siteKey: "pk_live_a" });
    expect(fp.strong).toBe(true);
  });

  it("still produces a stable value without SubtleCrypto", async () => {
    browser();
    stubs.set("crypto", {});
    const a = await deviceFingerprint({ siteKey: "pk_live_a" });
    const b = await deviceFingerprint({ siteKey: "pk_live_a" });
    expect(a.strong).toBe(false);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).toMatch(/^fp_[0-9a-f]{32}$/);
    const other = await deviceFingerprint({ siteKey: "pk_live_b" });
    expect(other.fingerprint).not.toBe(a.fingerprint);
  });

  it("never returns the raw components in the fingerprint itself", async () => {
    browser();
    const fp = await deviceFingerprint({ siteKey: "pk_live_a" });
    expect(fp.components["timezone"]).toBeDefined();
    expect(fp.fingerprint).not.toContain("MacIntel");
  });
});

describe("hardened browsers", () => {
  it("still yields a fingerprint when a property throws", async () => {
    browser();
    stubs.set("navigator", {
      get platform(): string {
        throw new Error("hardened");
      },
      language: "en-US",
    });
    const fp = await deviceFingerprint({ siteKey: "pk_live_a" });
    expect(fp.fingerprint).toMatch(/^fp_[0-9a-f]{32}$/);
    expect(fp.components["platform"]).toBeNull();
    expect(fp.components["language"]).toBe("en-US");
  });
});
