// Standalone drop-in entry: the same device fingerprint as the npm package,
// reachable from a plain <script> tag on a site with no bundler.
//
//   <script async src="/vectoral-fingerprint.js" data-site-key="pk_live_abc"></script>
//   const { fingerprint } = await window.vectoralFp.get();
//
// It posts NOTHING. Like the rest of this package it only computes and returns
// — your page forwards the value to your own backend. See docs/concepts/salts.md
// for why the publishable site key is the right salt here.
//
// GLOBAL NAME. Deliberately `vectoralFp`, not `vectoral`: the hosted sensor
// (cdn.vectoral.cloud/v1/sensor.js) assigns `window.vectoral = api` outright
// rather than merging, so sharing the name would make load order decide which
// script survives. A separate global lets both run on one page.

import { deviceFingerprint } from "./device.js";
import { doc, safe } from "./env.js";

/** Where the API is installed. See the note above on why it is not `vectoral`. */
export const GLOBAL_NAME = "vectoralFp";

/** Bumped when the shape of the global's API changes, not when the hash does. */
export const STANDALONE_VERSION = 1;

/** The parts of a <script> element we read. Kept structural so tests need no DOM. */
interface ScriptLike {
  src?: string;
  dataset?: Record<string, string | undefined>;
}

export interface StandaloneConfig {
  /** The publishable site key, or null when the tag carried none. */
  siteKey: string | null;
  /** Exposes raw components on the result. Off unless explicitly asked for. */
  debug: boolean;
}

/**
 * What `get()` resolves to. A deliberate subset of `DeviceFingerprint`:
 * `components` is withheld unless debug is on, because a global on a customer's
 * page puts raw probe values one JSON.stringify away from being sent somewhere.
 */
export interface PublicFingerprint {
  fingerprint: string;
  strong: boolean;
  coverage: { present: number; total: number };
  components?: Record<string, string | null>;
}

/**
 * Resolve configuration from the script tag that loaded this bundle.
 *
 * Query string wins over the data attribute, matching the convention the hosted
 * sensor already established, so one integration idiom covers both scripts.
 */
export function readConfig(el: ScriptLike | null | undefined): StandaloneConfig {
  // An inline tag, or one whose src is relative, gives an unparseable URL —
  // that costs us the query string, not the data attributes.
  const qs = safe<URLSearchParams | null>(
    () => new URL(el?.src ?? "").searchParams,
    null,
  );
  const ds = el?.dataset ?? {};
  return {
    siteKey: qs?.get("siteKey") || ds.siteKey || null,
    debug: qs?.get("debug") === "1" || ds.debug === "true",
  };
}

/**
 * The script element we were loaded by. `document.currentScript` is set while a
 * classic script runs (including `async` ones); the query is a fallback for the
 * cases where it is not, such as re-execution from a bundler.
 */
function currentScript(): ScriptLike | null {
  const d = doc() as (Document & { currentScript?: ScriptLike }) | undefined;
  if (!d) return null;
  return (
    d.currentScript ??
    safe(
      () =>
        d.querySelector?.(
          'script[src*="vectoral-fingerprint"]',
        ) as unknown as ScriptLike | null,
      null,
    )
  );
}

async function compute(cfg: StandaloneConfig): Promise<PublicFingerprint> {
  if (!cfg.siteKey) {
    throw new Error(
      `${GLOBAL_NAME}: no siteKey configured — add data-site-key="pk_live_…" ` +
        "to the script tag (it is the salt, so there is no default)",
    );
  }
  const r = await deviceFingerprint({ siteKey: cfg.siteKey });
  const out: PublicFingerprint = {
    fingerprint: r.fingerprint,
    strong: r.strong,
    coverage: r.coverage,
  };
  if (cfg.debug) out.components = r.components;
  return out;
}

type QueueEntry = [string, unknown, ((err: unknown, value?: unknown) => void)?];

/**
 * Install the API onto the global object.
 *
 * Any calls queued against `vectoralFp.q` before this bundle finished loading
 * are flushed afterwards, so an `async` script tag never silently drops work:
 *
 *   window.vectoralFp = window.vectoralFp || { q: [] };
 *   vectoralFp.q.push(["get", null, (err, fp) => …]);
 */
export function install(): void {
  const cfg = readConfig(currentScript());
  const g = globalThis as unknown as Record<string, unknown>;

  // The fingerprint does not change within a session, so one computation is
  // both correct and the documented usage. The promise is the cache.
  let cached: Promise<PublicFingerprint> | null = null;
  const get = (): Promise<PublicFingerprint> => (cached ??= compute(cfg));

  const pending = (g[GLOBAL_NAME] as { q?: unknown } | undefined)?.q;

  // `q` survives installation, and its `push` runs the entry immediately. With
  // an `async` script tag the integration snippet may run before OR after this
  // bundle, and a `q` that only worked in one of those orders would make the
  // documented snippet a coin flip.
  const api = {
    version: STANDALONE_VERSION,
    get,
    q: { push: (entry: QueueEntry) => flush([entry], api) },
  };
  g[GLOBAL_NAME] = api;

  // Start early so the value is ready by the time a form is submitted. Only
  // when configured: kicking off a doomed promise would surface as an unhandled
  // rejection in the customer's console rather than at their call site.
  if (cfg.siteKey) void get().catch(() => {});

  if (Array.isArray(pending)) flush(pending as QueueEntry[], api);
}

function flush(queue: QueueEntry[], api: { get: () => Promise<PublicFingerprint> }): void {
  for (const entry of queue) {
    if (!Array.isArray(entry)) continue;
    const [method, , cb] = entry;
    const fn = (api as unknown as Record<string, unknown>)[method];
    if (typeof fn !== "function") {
      cb?.(new Error(`${GLOBAL_NAME}: no such method \`${String(method)}\``));
      continue;
    }
    Promise.resolve((fn as () => unknown)()).then(
      (value) => cb?.(null, value),
      (err) => cb?.(err),
    );
  }
}
