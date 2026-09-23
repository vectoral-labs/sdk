// Test-only helpers for installing stub browser globals.
//
// `globalThis.navigator` is a getter-only accessor on modern Node, so a plain
// assignment throws — everything here goes through defineProperty and is
// restored afterwards.

const g = globalThis as unknown as Record<string, unknown>;

export class GlobalStubs {
  private readonly saved = new Map<string, PropertyDescriptor | undefined>();

  set(key: string, value: unknown): void {
    if (!this.saved.has(key)) {
      this.saved.set(key, Object.getOwnPropertyDescriptor(g, key));
    }
    Object.defineProperty(g, key, {
      value,
      configurable: true,
      writable: true,
      enumerable: true,
    });
  }

  remove(key: string): void {
    if (!this.saved.has(key)) {
      this.saved.set(key, Object.getOwnPropertyDescriptor(g, key));
    }
    delete g[key];
  }

  get(key: string): unknown {
    return g[key];
  }

  restore(): void {
    for (const [key, desc] of this.saved) {
      if (desc) Object.defineProperty(g, key, desc);
      else delete g[key];
    }
    this.saved.clear();
  }
}

/** A plausible, non-automated desktop Chrome on macOS. */
export function installCleanBrowser(
  s: GlobalStubs,
  navigatorOverrides: Record<string, unknown> = {},
): void {
  s.set("navigator", {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    platform: "MacIntel",
    language: "en-US",
    languages: ["en-US", "en"],
    hardwareConcurrency: 10,
    deviceMemory: 8,
    maxTouchPoints: 0,
    ...navigatorOverrides,
  });
  s.set("screen", { width: 1920, height: 1080, colorDepth: 24 });
  s.set("chrome", { runtime: {} });
  s.set("outerWidth", 1920);
  s.set("outerHeight", 1080);
  // No 2d/webgl context: both probes return null, exercising the degraded path
  // without pulling in jsdom.
  s.set("document", { createElement: () => ({ getContext: () => null }) });
}
