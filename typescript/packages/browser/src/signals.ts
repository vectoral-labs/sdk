// The one call a signup page makes: collect everything the browser can offer,
// shaped so your backend can forward it verbatim.

import { deviceFingerprint } from "./device.js";
import { detectAutomation } from "./automation.js";
import { nav, safe, timezone } from "./env.js";
import type { FormTracker, FormTelemetrySnapshot } from "./form.js";

export interface SignupSignalsOptions {
  /** Your publishable site key (`pk_live_…`). */
  siteKey: string;
  /** A tracker from `trackForm()`, if you wired one up. */
  form?: FormTracker;
  /** Threshold for `automation.automated`. Does not affect the score. */
  automationThreshold?: number;
}

/**
 * Exactly the shape `registrations.score()` accepts for these fields — post it
 * to your own endpoint and spread it into the request there.
 */
export interface SignupSignals {
  device_fingerprint: string;
  client: {
    /** Present only when the browser actually reported `navigator.webdriver`. */
    webdriver?: boolean;
    fingerprint_anomaly: number;
    load_to_submit_ms?: number;
    timezone?: string;
  };
  form?: FormTelemetrySnapshot;
  /** Diagnostics for your own logging. Not part of the wire contract. */
  diagnostics: {
    automation_score: number;
    automation_reasons: string[];
    fingerprint_strong: boolean;
    fingerprint_coverage: { present: number; total: number };
  };
}

/**
 * Collect every signup signal available in the browser.
 *
 * **Post this to your own backend, not to Vectoral.** The API key is a secret
 * and the IP must be read server-side. Your backend should also sanity-check
 * what arrives — clamp `fingerprint_anomaly` to [0,1] and ignore absent fields
 * — rather than trusting the client blindly.
 *
 * ```js
 * const tracker = trackForm(formEl);
 * // at submit:
 * const signals = await signupSignals({ siteKey: "pk_live_…", form: tracker });
 * await fetch("/api/signup", { method: "POST", body: JSON.stringify({ email, signals }) });
 * ```
 */
export async function signupSignals(
  opts: SignupSignalsOptions,
): Promise<SignupSignals> {
  // Written as two statements, not array-destructured from a literal. The
  // destructured form read as if the two ran concurrently; it never did —
  // array literals evaluate left to right, so the `await` completed before
  // `detectAutomation` was called. That was correct only because
  // `detectAutomation` is synchronous, and it would have silently become a
  // serialised round trip the day it gained an `await` of its own. Plain
  // statements say what actually happens; if these ever both become async,
  // `Promise.all` is the change to make and it will be obvious that it is one.
  const device = await deviceFingerprint({ siteKey: opts.siteKey });
  const automation = detectAutomation(
    opts.automationThreshold !== undefined
      ? { threshold: opts.automationThreshold }
      : {},
  );
  const formSnapshot = opts.form?.snapshot();
  const tz = timezone();
  const webdriver = safe(() => nav().webdriver, undefined);

  return {
    device_fingerprint: device.fingerprint,
    client: {
      // A real `false` is a useful negative; omitting the field says nothing.
      // So the field is included ONLY when the browser actually reported the
      // property. The automation tell cannot answer this — it is
      // `navigator.webdriver === true`, which reads `false` for "absent" and
      // for "measured false" alike, so probe the property directly.
      ...(typeof webdriver === "boolean" ? { webdriver } : {}),
      fingerprint_anomaly: automation.fingerprintAnomaly,
      ...(formSnapshot ? { load_to_submit_ms: formSnapshot.load_to_submit_ms } : {}),
      ...(tz ? { timezone: tz } : {}),
    },
    ...(formSnapshot ? { form: formSnapshot } : {}),
    diagnostics: {
      automation_score: automation.score,
      automation_reasons: automation.reasons,
      fingerprint_strong: device.strong,
      fingerprint_coverage: device.coverage,
    },
  };
}
