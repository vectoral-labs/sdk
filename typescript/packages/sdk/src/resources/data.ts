// POST /v1/import and GET /v1/import/{id} — load past events at their own
// timestamps — and the two readiness reports, GET /v1/data/status and
// GET /v1/integration/status.

import type { Transport } from "../http.js";
import { seg } from "../http.js";
import type { IdentityEvent } from "./identity.js";
import type { PostCallEvent, ScoreRequest } from "./inference.js";
import type { LabelRequest } from "./labels.js";

/**
 * One event to load. Set exactly the payload field that matches `type`; none,
 * or more than one, rejects the event.
 */
export interface ImportEvent {
  /** Required. Makes retrying a batch safe: a loaded id reports `duplicate`. */
  event_id: string;
  type: "score" | "post_call" | "identity" | "label";
  /**
   * RFC 3339. At least about an hour old and no older than 400 days. Becomes
   * the row's received time.
   */
  event_time: string;
  score?: ScoreRequest;
  post_call?: PostCallEvent;
  identity?: IdentityEvent;
  label?: LabelRequest;
}

export interface ImportBatch {
  /**
   * Groups every batch of one load into a single job for `imports.get()`.
   * Generated (`imp-<hex>`) when omitted, but a stable id is what makes the
   * status useful across batches.
   */
  import_id?: string;
  /** 1 to 1,000 events, body up to 8 MiB. Over either is a 400 for the batch. */
  events: ImportEvent[];
}

/**
 * Why an event was rejected. A versioned vocabulary: values are added, never
 * renamed or removed, so this is open to new ones.
 */
export type ImportRejectReason =
  | "missing_event_id"
  | "missing_event_time"
  | "event_time_in_future"
  | "event_time_too_recent"
  | "event_time_too_old"
  | "unknown_type"
  | "missing_payload"
  | "multiple_payloads"
  | "missing_account_id"
  | "invalid_label"
  | "unserializable_payload"
  | "store_error"
  | (string & {});

export interface ImportEventResult {
  event_id: string;
  status: "accepted" | "duplicate" | "rejected" | (string & {});
  /**
   * Why a `rejected` event was refused. Also appears on an `accepted` event
   * when part of it was dropped, e.g. `fingerprint_dropped:<why>`.
   */
  reason?: ImportRejectReason;
}

/** The result of one batch. Counts are for this batch only. */
export interface ImportResult {
  import_id: string;
  received: number;
  accepted: number;
  /** Already loaded — the normal result of retrying a batch. */
  duplicate: number;
  rejected: number;
  results: ImportEventResult[];
}

/** Totals across every batch sent under one `import_id`. */
export interface ImportStatus {
  import_id: string;
  created_at?: string;
  updated_at?: string;
  received: number;
  accepted: number;
  duplicate: number;
  rejected: number;
  first_event_time?: string | null;
  last_event_time?: string | null;
  /** Up to the first 100 rejections. */
  rejections: { event_id?: string; reason?: ImportRejectReason; at?: string }[];
  /** True when `rejections` is a sample of a larger set. */
  rejections_truncated: boolean;
}

/** How ready your imported history is. */
export interface DataStatus {
  /** Score requests stored, imported and live together. */
  rows: number;
  first_event_time: string | null;
  last_event_time: string | null;
  pending: number;
  stale: number;
  failed: number;
  featured: number;
  labels: { fraud: number; legitimate: number };
  /** Share of imported rows carrying each signal, and what it detects. */
  signal_coverage: { path: string; present: number; detects: string[] }[];
  detections_unavailable: string[];
  /**
   * Fingerprint volume per `salt_id`, highest first. Two sets of comparable
   * size means your export and live traffic used different salts.
   */
  fingerprint_coverage_by_salt: { salt_id: string; rows: number }[];
  /** True when counts came from a 1% sample (over 1,000,000 rows). */
  estimated: boolean;
}

export type IntegrationWindow = "1h" | "24h" | "7d" | "30d";

export interface IntegrationSignal {
  /** A dotted path into that endpoint's request body. */
  path: string;
  /** `required`, `high_yield` or `optional`: the order to do the work in. */
  tier: "required" | "high_yield" | "optional" | (string & {});
  /** Share of calls carrying it. `null` when there were no calls. */
  present: number | null;
  /** Detection identifiers. Stable to depend on; the set is open. */
  detects: string[];
  /** True if the signal transmits prompt content. */
  sends_prompt_content: boolean;
  /** For people. Don't parse. */
  description?: string;
  /** For people. Don't parse. */
  note?: string;
}

/** Which signals your live requests carry. */
export interface IntegrationStatus {
  window: IntegrationWindow | (string & {});
  estimated: boolean;
  detections_unavailable: string[];
  /** One entry per request endpoint; all three are always listed. */
  payloads: { endpoint: string; calls: number; signals: IntegrationSignal[] }[];
}

/** Batches can be large; give them longer than a scoring call. */
const IMPORT_TIMEOUT_FLOOR_MS = 30_000;

export class Imports {
  /**
   * `prepareScore` is `Inference.prepare`: it strips the local-only
   * `request.prompt_text_to_fingerprint` and fingerprints with the client's
   * salt, exactly as `inference.score()` does.
   */
  constructor(
    private readonly transport: Transport,
    private readonly prepareScore: (req: ScoreRequest) => ScoreRequest,
  ) {}

  /**
   * Load one batch of past events. A malformed event doesn't fail the batch:
   * check `rejected` and each `results[].reason`. Imported rows are inert —
   * never scored at ingest, never counted against spend caps.
   *
   * A `score` event is prepared the way `inference.score()` prepares a
   * request: `request.prompt_text_to_fingerprint` is stripped, and turned
   * into a `prompt_fingerprint` with your salt when fingerprinting is on.
   * Your batch object is not mutated.
   *
   * Every event requires an `event_id`, so a transient failure is retried
   * and a repeat reports `duplicate`. The HTTP timeout is at least 30 s, or
   * `timeoutMs` if you pass a larger one.
   */
  send(batch: ImportBatch, opts: { timeoutMs?: number } = {}): Promise<ImportResult> {
    const body: ImportBatch = {
      ...batch,
      events: batch.events.map((e) =>
        e.score?.request ? { ...e, score: this.prepareScore(e.score) } : e,
      ),
    };
    return this.transport.post<ImportResult>("/v1/import", body, {
      idempotent: batch.events.every((e) => e.event_id !== undefined && e.event_id !== ""),
      timeoutMs: Math.max(opts.timeoutMs ?? 0, IMPORT_TIMEOUT_FLOOR_MS),
    });
  }

  /** Combined status of every batch sent under `importId`. 404 if unknown. */
  async get(importId: string): Promise<ImportStatus> {
    return this.transport.get<ImportStatus>(`/v1/import/${seg(importId)}`);
  }
}

export class Data {
  constructor(private readonly transport: Transport) {}

  /**
   * How much imported history Vectoral holds, how much is processed, and
   * which signals it is missing. Score requests only.
   */
  status(): Promise<DataStatus> {
    return this.transport.get<DataStatus>("/v1/data/status");
  }

  /**
   * Which signals your live requests carry across `/v1/score`,
   * `/v1/events/post-call` and `/v1/identity`, and which detections that
   * leaves unavailable. Works before you have sent anything.
   */
  integrationStatus(params: { window?: IntegrationWindow } = {}): Promise<IntegrationStatus> {
    return this.transport.get<IntegrationStatus>("/v1/integration/status", { ...params });
  }
}
