// POST /v1/labels — ground truth. This is what the models train on.

import type { Transport } from "../http.js";
import type { OkResponse } from "./inference.js";

export type Label = "fraud" | "legitimate";

export interface LabelRequest {
  account_id: string;
  label: Label;
  notes?: string;
}

export class Labels {
  constructor(private readonly transport: Transport) {}

  /**
   * Report a verdict you reached yourself — a chargeback, a ban, a support
   * resolution. Label legitimate accounts too: a corpus of only-fraud labels
   * teaches a model nothing about the boundary.
   */
  submit(req: LabelRequest): Promise<OkResponse> {
    return this.transport.post<OkResponse>("/v1/labels", req, { idempotent: false });
  }

  fraud(accountId: string, notes?: string): Promise<OkResponse> {
    return this.submit({
      account_id: accountId,
      label: "fraud",
      ...(notes !== undefined ? { notes } : {}),
    });
  }

  legitimate(accountId: string, notes?: string): Promise<OkResponse> {
    return this.submit({
      account_id: accountId,
      label: "legitimate",
      ...(notes !== undefined ? { notes } : {}),
    });
  }
}
