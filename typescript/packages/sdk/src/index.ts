// @vectoral/sdk — server-side SDK for the Vectoral fraud-scoring API.
//
//   vectoral.registrations.score()  screen a signup before the account exists
//   vectoral.inference.score()      score an inference request before the call
//   vectoral.inference.postCall()   report what the call actually cost
//   vectoral.identity.record()      signup/login events, and registration links
//   vectoral.labels.submit()        ground truth
//
// SERVER-SIDE ONLY. It carries a secret API key, and the client IP it sends is
// only meaningful when your server observed it. Browser-side collection lives
// in @vectoral/browser, whose output you forward through here.

export { Vectoral, createClient } from "./client.js";
export type { VectoralOptions } from "./client.js";

export { VectoralError, VectoralConfigError } from "./errors.js";
export type { VectoralErrorCode } from "./errors.js";
export type { FetchLike } from "./http.js";

export { Registrations, RegistrationTier } from "./resources/registrations.js";
export type {
  RegistrationRequest,
  RegistrationVerdict,
  RegistrationClientBlock,
  RegistrationFormBlock,
  RegistrationFormField,
} from "./resources/registrations.js";

export { Inference } from "./resources/inference.js";
export type {
  ScoreRequest,
  ScoreResponse,
  PostCallEvent,
  OkResponse,
  AccountBlock,
  RequestBlock,
  SessionSignals,
  PromptFingerprintBlock,
  ReasonCode,
  Tier,
} from "./resources/inference.js";

export { Identity } from "./resources/identity.js";
export type { IdentityEvent, IdentityEventType } from "./resources/identity.js";

export { Labels } from "./resources/labels.js";
export type { Label, LabelRequest } from "./resources/labels.js";

export { generateSalt, suggestSaltId, MIN_SALT_LENGTH } from "./salt.js";
export type { FingerprintOptions } from "./salt.js";

export { computeFingerprint, conversationKey } from "./fingerprint/index.js";
export type { ComputedFingerprint } from "./fingerprint/index.js";
