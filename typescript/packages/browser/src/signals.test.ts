import { describe, it, expect, afterEach } from "vitest";
import { signupSignals } from "./signals.js";
import { GlobalStubs, installCleanBrowser } from "./test-globals.js";

const stubs = new GlobalStubs();

afterEach(() => stubs.restore());

describe("signupSignals", () => {
  it("omits `webdriver` when the browser never reported it", async () => {
    // `navigator.webdriver` is absent here. Reporting `false` would hand the
    // server a favourable negative nobody measured — and per
    // registration-screening.md, omitting the field says nothing while a real
    // `false` is a useful signal. The two must stay distinguishable.
    installCleanBrowser(stubs);

    const signals = await signupSignals({ siteKey: "pk_live_a" });

    expect(signals.client).not.toHaveProperty("webdriver");
  });

  it("reports a measured `false` as false", async () => {
    installCleanBrowser(stubs, { webdriver: false });

    const signals = await signupSignals({ siteKey: "pk_live_a" });

    expect(signals.client.webdriver).toBe(false);
  });

  it("reports a measured `true` as true", async () => {
    installCleanBrowser(stubs, { webdriver: true });

    const signals = await signupSignals({ siteKey: "pk_live_a" });

    expect(signals.client.webdriver).toBe(true);
  });
});
