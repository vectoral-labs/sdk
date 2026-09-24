// End-to-end walkthrough: screen a signup, link the account, score an
// inference call, report its cost, and label the account.
//
//   VECTORAL_API_KEY=… VECTORAL_BASE_URL=http://localhost:8080 \
//     VECTORAL_DEMO_EMAIL_DOMAIN=demo.yourcompany.com \
//     npx tsx examples/full-flow.ts
//
// Point it at a local dev instance, not production — it writes real rows.
//
// Run it back to back a dozen times and you will build a registration wave:
// same origin, same domain, local parts that differ by a random suffix. The
// correlation signals are supposed to catch that, and they will, including on
// the run you meant to be clean. See docs/concepts/registration-screening.md,
// "Before you test this".

import { randomUUID } from "node:crypto";
import {
  Vectoral,
  RegistrationTier,
  VectoralError,
  generateSalt,
  suggestSaltId,
} from "../packages/sdk/src/index.js";

const baseUrl = process.env.VECTORAL_BASE_URL;
if (!process.env.VECTORAL_API_KEY || !baseUrl) {
  console.error(
    "Set VECTORAL_API_KEY and VECTORAL_BASE_URL (a dev instance, not production).",
  );
  process.exit(1);
}

// Reserved names from RFC 2606 and RFC 6761. Every one of them publishes a null
// MX — a standards-mandated declaration that the domain cannot receive mail —
// which is exactly what the `email_infrastructure` signal detects. An address on
// one of these can never produce a clean verdict, so this example used to open
// by demonstrating a signal firing and calling it a demo.
const RESERVED_DOMAINS = ["example.com", "example.net", "example.org"];
const RESERVED_TLDS = ["example", "invalid", "localhost", "test"];

// Matched on label boundaries, never as a bare substring: `mail.example.com` is
// reserved and `notexample.com` is a perfectly ordinary domain somebody owns.
const isReserved = (domain: string): boolean =>
  RESERVED_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`)) ||
  RESERVED_TLDS.some((t) => domain === t || domain.endsWith(`.${t}`));

const emailDomain = (process.env.VECTORAL_DEMO_EMAIL_DOMAIN ?? "")
  .trim()
  .toLowerCase()
  .replace(/^@/, "");

if (!emailDomain) {
  console.error(
    "Set VECTORAL_DEMO_EMAIL_DOMAIN to a domain you control, e.g. demo.yourcompany.com.\n" +
      "\n" +
      "There is no safe default. A reserved domain (example.com and friends) cannot\n" +
      "receive mail, so it trips email_infrastructure on every run and no signup can\n" +
      "reach tier 0 — and after enough runs the domain also picks up disposable_email\n" +
      "and email_reputation inside your tenant, permanently. Any other fixed default\n" +
      "would put every reader's demo traffic on one domain, which is the same problem\n" +
      "with a worse blast radius.",
  );
  process.exit(1);
}

if (isReserved(emailDomain)) {
  console.error(
    `VECTORAL_DEMO_EMAIL_DOMAIN=${emailDomain} is a reserved domain.\n` +
      "\n" +
      "Reserved domains publish a null MX, so email_infrastructure fires on every\n" +
      "signup and the verdicts you are about to read would tell you nothing about\n" +
      "the rest of what you sent. Use a domain you control.",
  );
  process.exit(1);
}

const vectoral = new Vectoral({
  baseUrl,
  onError: (err, context) => console.warn(`  ! degraded [${context}]: ${err.message}`),
  fingerprint: {
    enabled: true,
    // A real deployment reads these from a secret manager. Generating one here
    // is fine only because nothing in this script is compared across runs.
    salt: process.env.VECTORAL_FINGERPRINT_SALT ?? generateSalt(),
    saltId: process.env.VECTORAL_FINGERPRINT_SALT_ID ?? suggestSaltId(),
  },
});

const accountId = `demo_${randomUUID().slice(0, 8)}`;
const sessionId = `sess_${randomUUID().slice(0, 8)}`;
// Stands in for your pending-signup row's primary key.
const pendingSignupId = randomUUID();

// 1 — screen the registration, before the account exists.
console.log("1. registrations.score");
const verdict = await vectoral.registrations.score({
  email: `${accountId}@${emailDomain}`,
  event_id: pendingSignupId,
  ip: "203.0.113.47",
  user_agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0.0.0",
  device_fingerprint: "fp_demo_9c1e4a7b",
  client: { webdriver: false, fingerprint_anomaly: 0.0, timezone: "Europe/Berlin" },
  form: {
    load_to_submit_ms: 8400,
    fields: {
      email: { pasted: false, keystrokes: 22, corrections: 2, focus_ms: 3100 },
      password: { pasted: true, keystrokes: 0, corrections: 0, focus_ms: 400 },
    },
  },
  deadline_ms: 600,
});
console.log(`   tier=${verdict.tier} score=${verdict.score} degraded=${verdict.degraded}`);
if (verdict.reasons.length) console.log(`   reasons: ${verdict.reasons.join(", ")}`);
if (verdict.shadow_mode) console.log("   (warm-up window: tier is pinned to 0)");

// Compare, never switch — the tier scale is open-ended.
if (verdict.tier >= RegistrationTier.StepUp) console.log("   -> would require payment");
else if (verdict.tier >= RegistrationTier.Challenge) console.log("   -> would challenge");
else console.log("   -> would allow");

// 2 — the account now exists; link it to the registration that produced it.
if (verdict.registration_id) {
  console.log("2. identity.linkRegistration");
  await vectoral.identity.linkRegistration(accountId, verdict.registration_id, {
    ip: "203.0.113.47",
    event_id: `signup-${accountId}`,
  });
  console.log(`   linked ${verdict.registration_id} -> ${accountId}`);
} else {
  console.log("2. identity.linkRegistration — skipped (no registration_id: degraded)");
}

// 3 — score an inference request. The prompt is fingerprinted in-process and
//     never leaves it.
console.log("3. inference.score");
const score = await vectoral.inference.score({
  account_id: accountId,
  session_id: sessionId,
  account: { first_seen: new Date().toISOString(), subscription_tier: "free" },
  request: {
    ip: "203.0.113.47",
    model_requested: "claude-opus-5",
    estimated_prompt_tokens: 1200,
    session_signals: {
      ms_since_last_request: 4200,
      interaction_events_count: 7,
      is_first_request_in_session: true,
    },
    prompt_text_to_fingerprint:
      "write a detailed product description for a pair of running shoes aimed at marathon trainees",
  },
});
console.log(
  `   score=${score.score} tier=${score.tier} baseline_ready=${score.baseline_ready}`,
);

// 4 — report what the call cost. This is where velocity and cost signals come
//     from; a score-only integration starves itself.
console.log("4. inference.postCall");
try {
  await vectoral.inference.postCall({
    account_id: accountId,
    session_id: sessionId,
    model: "claude-opus-5",
    prompt_tokens: 1187,
    completion_tokens: 642,
    latency_ms: 2310,
    event_id: `call-${randomUUID().slice(0, 8)}`,
  });
  console.log("   ok");
} catch (err) {
  // postCall never fails open — a transient failure belongs on a queue, not in
  // a swallowed catch.
  if (err instanceof VectoralError && err.transient) {
    console.warn("   transient failure — would enqueue for retry");
  } else {
    throw err;
  }
}

// 5 — ground truth. Without it, nothing improves.
console.log("5. labels.legitimate");
await vectoral.labels.legitimate(accountId, "demo run");
console.log("   ok");

console.log(`\nDone. Account ${accountId} now has a registration, a score, telemetry, and a label.`);
