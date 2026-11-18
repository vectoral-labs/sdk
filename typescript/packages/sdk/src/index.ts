// @vectoral-labs/sdk — server-side SDK for the Vectoral fraud-scoring API.
//
//   vectoral.registrations.score()  screen a signup before the account exists
//   vectoral.inference.score()      score an inference request before the call
//   vectoral.inference.postCall()   report what the call actually cost
//   vectoral.identity.record()      signup/login events, and registration links
//   vectoral.labels.submit()        ground truth, and settling account flags
//   vectoral.registrations.get()    read a stored signup verdict back
//   vectoral.registrations.reportStepUp()  report a step-up result
//   vectoral.sensor.verify()        check a browser sensor token
//   vectoral.flags / accounts       read flags, accounts and score history
//   vectoral.imports / data         load history; check signal coverage
//   verifyWebhookSignature()        authenticate a webhook you received
//
// SERVER-SIDE ONLY. It carries a secret API key, and the client IP it sends is
// only meaningful when your server observed it. Browser-side collection lives
// in @vectoral-labs/browser, whose output you forward through here.

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
  RegistrationIdentity,
  RegistrationAddress,
  RegistrationDetail,
  RegistrationLabelRequest,
  RegistrationLabelResponse,
  StepUpReport,
  StepUpResult,
  Screening,
  ScreeningStatus,
  ScreeningMatch,
  ScreeningEmbargo,
  ScreeningListVersion,
  ScreeningAudit,
  ScreeningInputWarning,
  ClearanceRequest,
  ClearanceResponse,
  ClearanceRevokeResponse,
} from "./resources/registrations.js";

export { Inference } from "./resources/inference.js";
export type {
  ScoreRequest,
  ScoreResponse,
  PostCallEvent,
  OkResponse,
  AccountBlock,
  AccountContextBlock,
  RequestBlock,
  AccountFlagState,
  SessionSignals,
  PromptFingerprintBlock,
  ReasonCode,
  Tier,
} from "./resources/inference.js";

export { Identity } from "./resources/identity.js";
export type { IdentityEvent, IdentityEventType } from "./resources/identity.js";

export { Labels } from "./resources/labels.js";
export type {
  Label,
  LabelRequest,
  LabelResponse,
  LabelOptions,
  FlagAdjudication,
} from "./resources/labels.js";

export type {
  Action,
  ScoreAction,
  ActionReason,
  RegistrationReason,
  FlagLevel,
  FlagStatus,
  FlagReason,
  FlagSource,
  ReraiseCause,
  LabelReasonCode,
  SensorDecision,
} from "./resources/shared.js";

export { Sensor } from "./resources/sensor.js";
export type { SensorVerifyRequest, SensorVerifyResponse } from "./resources/sensor.js";

export { Flags } from "./resources/flags.js";
export type { AccountFlag, FlagList, FlagListParams } from "./resources/flags.js";

export { Accounts } from "./resources/accounts.js";
export type {
  AccountWindow,
  StoredTier,
  AccountListParams,
  AccountListItem,
  AccountList,
  AccountDetail,
  ScoreSummary,
  ScoreHistoryItem,
  AccountScoreList,
  CommerceEvent,
  CommerceEventType,
  Stats,
} from "./resources/accounts.js";

export { Imports, Data } from "./resources/data.js";
export type {
  ImportEvent,
  ImportBatch,
  ImportResult,
  ImportEventResult,
  ImportRejectReason,
  ImportStatus,
  DataStatus,
  IntegrationStatus,
  IntegrationSignal,
  IntegrationWindow,
} from "./resources/data.js";

export {
  verifyWebhookSignature,
  parseWebhook,
  signWebhookPayload,
  isWebhookEvent,
  WebhookVerificationError,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_TOLERANCE_SECONDS,
} from "./webhooks.js";
export type {
  VerifyWebhookOptions,
  WebhookVerificationFailure,
  WebhookEnvelope,
  WebhookEventType,
  WebhookEventDataMap,
  WebhookLinks,
  WebhookOriginData,
  WebhookChannel,
  WebhookActorType,
  AccountFlaggedData,
  AccountFlagDismissedData,
  AccountFlagConfirmedData,
  AccountFlagExpiredData,
  AccountReviewCompletedData,
  ReviewFinding,
  ReviewModel,
  RegistrationReviewRequestedData,
  RegistrationReviewDecidedData,
  PingData,
} from "./webhooks.js";

export { generateSalt, suggestSaltId, MIN_SALT_LENGTH } from "./salt.js";
export type { FingerprintOptions } from "./salt.js";

export { computeFingerprint, conversationKey } from "./fingerprint/index.js";
export type { ComputedFingerprint } from "./fingerprint/index.js";
