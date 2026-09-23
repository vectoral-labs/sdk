import { describe, it, expect, afterEach } from "vitest";
import { readConfig, install, GLOBAL_NAME } from "./standalone.js";
import { GlobalStubs, installCleanBrowser } from "./test-globals.js";

const stubs = new GlobalStubs();

/** A stand-in for the `<script>` tag this bundle was loaded by. */
const scriptEl = (src: string, dataset: Record<string, string> = {}) => ({
  src,
  dataset,
});

/** Install a clean browser whose `document.currentScript` is `el`. */
function browserWithScript(el: unknown): void {
  installCleanBrowser(stubs);
  const doc = stubs.get("document") as Record<string, unknown>;
  stubs.set("document", {
    ...doc,
    currentScript: el,
    querySelector: () => null,
  });
}

afterEach(() => stubs.restore());

describe("readConfig", () => {
  it("reads the site key from a data attribute", () => {
    const cfg = readConfig(
      scriptEl("https://cdn.example.com/vectoral-fingerprint.js", {
        siteKey: "pk_live_from_data",
      }),
    );
    expect(cfg.siteKey).toBe("pk_live_from_data");
  });

  it("reads the site key from the script src query string", () => {
    const cfg = readConfig(
      scriptEl("https://cdn.example.com/vectoral-fingerprint.js?siteKey=pk_live_from_qs"),
    );
    expect(cfg.siteKey).toBe("pk_live_from_qs");
  });

  it("prefers the query string over the data attribute, as the sensor does", () => {
    const cfg = readConfig(
      scriptEl("https://cdn.example.com/f.js?siteKey=pk_live_qs", {
        siteKey: "pk_live_data",
      }),
    );
    expect(cfg.siteKey).toBe("pk_live_qs");
  });

  it("reports a null site key when the tag carries none", () => {
    const cfg = readConfig(scriptEl("https://cdn.example.com/f.js"));
    expect(cfg.siteKey).toBeNull();
  });

  it("survives a script element with an unparseable src", () => {
    const cfg = readConfig(scriptEl("", { siteKey: "pk_live_a" }));
    expect(cfg.siteKey).toBe("pk_live_a");
  });

  it("survives no script element at all", () => {
    expect(readConfig(null).siteKey).toBeNull();
  });

  it("is not in debug mode by default", () => {
    expect(readConfig(scriptEl("https://x/f.js")).debug).toBe(false);
  });

  it("enables debug from either the query string or a data attribute", () => {
    expect(readConfig(scriptEl("https://x/f.js?debug=1")).debug).toBe(true);
    expect(readConfig(scriptEl("https://x/f.js", { debug: "true" })).debug).toBe(true);
  });
});

describe("install", () => {
  it("exposes the global", () => {
    browserWithScript(scriptEl("https://x/f.js", { siteKey: "pk_live_a" }));
    install();
    expect(stubs.get(GLOBAL_NAME)).toBeDefined();
  });

  it("resolves a fingerprint in the documented shape", async () => {
    browserWithScript(scriptEl("https://x/f.js", { siteKey: "pk_live_a" }));
    install();
    const api = stubs.get(GLOBAL_NAME) as { get: () => Promise<Record<string, unknown>> };

    const result = await api.get();

    expect(result.fingerprint).toMatch(/^fp_[0-9a-f]{32}$/);
    expect(result.strong).toBe(true);
    expect(result.coverage).toEqual({ present: expect.any(Number), total: expect.any(Number) });
  });

  it("agrees with the npm entry point for the same site key", async () => {
    const { deviceFingerprint } = await import("./device.js");
    browserWithScript(scriptEl("https://x/f.js", { siteKey: "pk_live_same" }));
    install();
    const api = stubs.get(GLOBAL_NAME) as { get: () => Promise<{ fingerprint: string }> };

    const viaGlobal = await api.get();
    const viaModule = await deviceFingerprint({ siteKey: "pk_live_same" });

    expect(viaGlobal.fingerprint).toBe(viaModule.fingerprint);
  });

  it("computes once and reuses the result", async () => {
    browserWithScript(scriptEl("https://x/f.js", { siteKey: "pk_live_a" }));
    install();
    const api = stubs.get(GLOBAL_NAME) as { get: () => Promise<unknown> };

    const [a, b] = [await api.get(), await api.get()];

    expect(a).toBe(b);
  });

  it("withholds raw components unless debug is on", async () => {
    browserWithScript(scriptEl("https://x/f.js", { siteKey: "pk_live_a" }));
    install();
    const api = stubs.get(GLOBAL_NAME) as { get: () => Promise<Record<string, unknown>> };

    expect(await api.get()).not.toHaveProperty("components");
  });

  it("includes raw components when debug is on", async () => {
    browserWithScript(
      scriptEl("https://x/f.js", { siteKey: "pk_live_a", debug: "true" }),
    );
    install();
    const api = stubs.get(GLOBAL_NAME) as { get: () => Promise<Record<string, unknown>> };

    expect(await api.get()).toHaveProperty("components");
  });

  it("rejects with an actionable message when no site key was configured", async () => {
    browserWithScript(scriptEl("https://x/f.js"));
    install();
    const api = stubs.get(GLOBAL_NAME) as { get: () => Promise<unknown> };

    await expect(api.get()).rejects.toThrow(/siteKey/);
  });

  it("flushes calls queued before the async bundle loaded", async () => {
    browserWithScript(scriptEl("https://x/f.js", { siteKey: "pk_live_a" }));
    const seen: { err: unknown; value: { fingerprint: string } | undefined }[] = [];
    stubs.set(GLOBAL_NAME, {
      q: [["get", undefined, (err: unknown, value: { fingerprint: string } | undefined) =>
        seen.push({ err, value })]],
    });

    install();
    await new Promise((r) => setTimeout(r, 0));

    const [first] = seen;
    expect(seen).toHaveLength(1);
    expect(first?.err).toBeNull();
    expect(first?.value?.fingerprint).toMatch(/^fp_[0-9a-f]{32}$/);
  });

  it("runs calls pushed to the queue after the bundle already loaded", async () => {
    // Load order is not knowable with an `async` script tag: the integration
    // snippet may run before OR after this bundle. Pushing to `q` must work
    // either way, or every integrator has to branch on it themselves.
    browserWithScript(scriptEl("https://x/f.js", { siteKey: "pk_live_a" }));
    install();
    const api = stubs.get(GLOBAL_NAME) as { q: { push: (e: unknown) => void } };
    const seen: { err: unknown; value: { fingerprint: string } | undefined }[] = [];

    api.q.push(["get", undefined, (err: unknown, value: { fingerprint: string } | undefined) =>
      seen.push({ err, value })]);
    await new Promise((r) => setTimeout(r, 0));

    const [first] = seen;
    expect(seen).toHaveLength(1);
    expect(first?.err).toBeNull();
    expect(first?.value?.fingerprint).toMatch(/^fp_[0-9a-f]{32}$/);
  });

  it("leaves the sensor's `window.vectoral` untouched", () => {
    browserWithScript(scriptEl("https://x/f.js", { siteKey: "pk_live_a" }));
    const sensor = { version: 3, getToken: () => Promise.resolve("tok") };
    stubs.set("vectoral", sensor);

    install();

    expect(stubs.get("vectoral")).toBe(sensor);
  });
});
