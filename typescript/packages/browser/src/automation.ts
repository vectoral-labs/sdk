// Automation tells — is this browser being driven by a script?
//
// TRUST MODEL. This runs on the abuser's machine. Stealth frameworks
// (puppeteer-extra-stealth, undetected-chromedriver) patch most of these tells,
// and an attacker can strip the script or fake the posted score outright. Treat
// the output as a soft signal that raises suspicion — strongest when several
// independent tells fire together — never as a standalone block. The
// spoof-resistant signals live server-side.

import { doc, nav, safe, screenInfo, webglInfo, win } from "./env.js";

export interface AutomationResult {
  /** Noisy-OR combination of the weights that fired, in [0,1]. */
  score: number;
  /** `score >= threshold`. */
  automated: boolean;
  /** Names of the tells that fired, strongest first. */
  reasons: string[];
  /** Every tell that was evaluated, whether it fired or not. */
  signals: Record<string, boolean>;
  /**
   * The environment-inconsistency subscore in [0,1] — the part of the evidence
   * that comes from the browser contradicting itself rather than from an
   * injected global. Send this as `client.fingerprint_anomaly`.
   */
  fingerprintAnomaly: number;
}

export interface DetectAutomationOptions {
  /** Decision point for `automated`. Default 0.6. */
  threshold?: number;
}

interface Tell {
  name: string;
  weight: number;
  /** True when the tell is an environment contradiction, not an injected hook. */
  inconsistency?: boolean;
  test: () => boolean;
}

const AUTOMATION_GLOBALS = [
  "__playwright",
  "__puppeteer",
  "__pw_manual",
  "_phantom",
  "__nightmare",
  "callPhantom",
  "domAutomation",
  "domAutomationController",
  "_Selenium_IDE_Recorder",
  "__selenium_unwrapped",
  "__webdriver_evaluate",
  "__driver_evaluate",
];

const tells = (): Tell[] => {
  // Every read here must be guarded: a hardened browser can install a throwing
  // getter on any of these, and a detector that dies on one is worth less than
  // one that reports the tells it could reach.
  const n = safe(nav, {});
  const w = safe(win, {} as Record<string, unknown>);
  const ua = safe(() => n.userAgent ?? "", "");
  const s = screenInfo();
  const gl = webglInfo();

  return [
    {
      name: "webdriver_flag",
      weight: 0.85,
      test: () => n.webdriver === true,
    },
    {
      name: "automation_globals",
      weight: 0.85,
      test: () => AUTOMATION_GLOBALS.some((k) => k in w),
    },
    {
      name: "chromedriver_cdc",
      weight: 0.85,
      test: () =>
        safe(() => {
          const d = doc();
          if (!d) return false;
          return Object.keys(d).some((k) => k.startsWith("cdc_") || k.startsWith("$cdc_"));
        }, false),
    },
    {
      name: "headless_user_agent",
      weight: 0.8,
      test: () => /headless/i.test(ua),
    },
    {
      name: "empty_languages",
      weight: 0.55,
      inconsistency: true,
      test: () => Array.isArray(n.languages) && n.languages.length === 0,
    },
    {
      name: "zero_outer_window",
      weight: 0.5,
      inconsistency: true,
      test: () =>
        safe(() => {
          const outer = w as { outerWidth?: number; outerHeight?: number };
          return outer.outerWidth === 0 || outer.outerHeight === 0;
        }, false),
    },
    {
      name: "native_code_patched",
      weight: 0.45,
      inconsistency: true,
      // Stealth plugins replace native functions with JS shims. A genuine
      // built-in stringifies to "[native code]"; a shim does not.
      test: () =>
        safe(() => {
          const fns: unknown[] = [
            (n as { permissions?: { query?: unknown } }).permissions?.query,
            (w as { Function?: { prototype?: { toString?: unknown } } }).Function
              ?.prototype?.toString,
          ];
          return fns.some(
            (f) => typeof f === "function" && !/\[native code\]/.test(String(f)),
          );
        }, false),
    },
    {
      name: "webgl_software_renderer",
      weight: 0.45,
      inconsistency: true,
      test: () => /swiftshader|llvmpipe|software|mesa offscreen/i.test(gl?.renderer ?? ""),
    },
    {
      name: "chrome_object_missing",
      weight: 0.4,
      inconsistency: true,
      test: () => /chrome/i.test(ua) && !("chrome" in w),
    },
    {
      name: "zero_screen",
      weight: 0.4,
      inconsistency: true,
      test: () => s.width === 0 || s.height === 0,
    },
    {
      name: "platform_ua_mismatch",
      weight: 0.35,
      inconsistency: true,
      test: () => {
        const platform = n.userAgentData?.platform ?? n.platform ?? "";
        if (!platform || !ua) return false;
        const claimed = /windows/i.test(ua)
          ? "win"
          : /mac os|macintosh/i.test(ua)
            ? "mac"
            : /linux|android/i.test(ua)
              ? "linux"
              : null;
        if (!claimed) return false;
        const actual = platform.toLowerCase();
        if (claimed === "win") return !/win/.test(actual);
        if (claimed === "mac") return !/mac/.test(actual);
        return !/linux|android|arm/.test(actual);
      },
    },
  ];
};

/** `1 - Π(1 - w)`: one strong tell dominates; several weak ones still add up. */
const noisyOr = (weights: number[]): number =>
  weights.length === 0 ? 0 : 1 - weights.reduce((acc, w) => acc * (1 - w), 1);

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Evaluate every automation tell against the current browser. Synchronous and
 * cheap — safe to call on every protected action.
 */
export function detectAutomation(opts: DetectAutomationOptions = {}): AutomationResult {
  const threshold = opts.threshold ?? 0.6;
  const evaluated = tells().map((t) => ({ ...t, fired: safe(t.test, false) }));

  const fired = evaluated.filter((t) => t.fired).sort((a, b) => b.weight - a.weight);
  const score = noisyOr(fired.map((t) => t.weight));
  const anomaly = noisyOr(fired.filter((t) => t.inconsistency).map((t) => t.weight));

  const signals: Record<string, boolean> = {};
  for (const t of evaluated) signals[t.name] = t.fired;

  return {
    score: round2(score),
    automated: score >= threshold,
    reasons: fired.map((t) => t.name),
    signals,
    fingerprintAnomaly: round2(anomaly),
  };
}
