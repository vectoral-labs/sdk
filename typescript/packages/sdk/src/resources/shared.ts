// Value sets shared by more than one endpoint.
//
// Every response-side set here is OPEN: the API can add a value without a new
// version, and the SDK passes unknown values through untouched rather than
// rejecting them. The `(string & {})` member is what lets an unlisted value
// type-check while keeping the known ones in autocomplete. Never write an
// exhaustive `switch` over one of these; give the default branch the safest
// behaviour you handle.

/**
 * What to do with a request or signup, decided by your Action Policy.
 *
 * Present only when the Action Policy is turned on for your organisation.
 * **Treat a value you don't recognise as `allow`, and log it.**
 *
 * - `allow`: let it through.
 * - `challenge`: a captcha or similar light check.
 * - `step_up`: require payment or identity verification, then report the
 *   result with `registrations.reportStepUp()`.
 * - `review`: hold the signup for your team's review queue.
 * - `block`: refuse it.
 *
 * `inference.score()` only returns `allow` or `block` (see `ScoreAction`);
 * `registrations.score()` can return any of them.
 */
export type Action =
  | "allow"
  | "challenge"
  | "step_up"
  | "review"
  | "block"
  | (string & {});

/** The action on an `inference.score()` verdict. An open set; treat unknown as `allow`. */
export type ScoreAction = "allow" | "block" | (string & {});

/**
 * Why `action` was chosen. An open set.
 *
 * - `score_threshold`: the score decided it, against your threshold or the tier.
 * - `auto_block_off`: "Block requests automatically" is off.
 * - `enforcement`: a manual block or a tripped spend cap.
 * - `shadow`: shadow mode is on and the policy would have acted; see
 *   `policy_action` for what it would have done.
 * - `policy_floor`: one of your tier floors raised the outcome.
 * - `domain_rule`: a rule for the email domain decided it.
 * - `sanctions_embargo`: the signup is from an embargoed location.
 * - `sanctions_match`: the signup matched a sanctions list.
 */
export type ActionReason =
  | "score_threshold"
  | "auto_block_off"
  | "enforcement"
  | "shadow"
  | "policy_floor"
  | "domain_rule"
  | "sanctions_embargo"
  | "sanctions_match"
  | (string & {});

/**
 * Facts that contributed to a signup verdict. Also the vocabulary of the
 * API's `degraded` list. An open set: log a code you don't recognise.
 */
export type RegistrationReason =
  | "email_infrastructure"
  | "fresh_domain"
  | "disposable_email"
  | "email_reputation"
  | "address_permutation"
  | "registration_wave"
  | "device_reuse"
  | "client_automation"
  | "form_behavior"
  | "origin_risk"
  | "sanctions_match"
  | "sanctions_embargo"
  | (string & {});

/**
 * How worried Vectoral is about an account. An open set.
 *
 * `normal` appears only on an account's flag state, never on a flag.
 */
export type FlagLevel = "normal" | "watch" | "flagged" | (string & {});

/** Where a flag stands. An open set. */
export type FlagStatus = "open" | "expired" | "dismissed" | "confirmed" | (string & {});

/**
 * Why an account is at its flag level. An open set.
 *
 * A rule added for your organisation carries a numeric suffix after a dot,
 * such as `high_calls.2`; treat the part before the dot as the rule.
 */
export type FlagReason =
  | "high_share_new_origin"
  | "usage_jump_new_origin"
  | "high_streak"
  | "spend_ceiling"
  | "probation_high"
  | "high_burst"
  | "high_calls"
  | "high_share_jump"
  | "spend_high"
  | "new_origin"
  | (string & {});

/** What set a flag's level or opened the flag. An open set. */
export type FlagSource =
  | "rule"
  | "review"
  | "user"
  | "api_key"
  | "staff"
  | "case"
  | "system"
  | (string & {});

/** Why a flag reopened soon after an earlier one was dismissed. An open set. */
export type ReraiseCause =
  | "new_origin"
  | "new_rule"
  | "materially_worse"
  | "spend_ceiling"
  | "suppression_lapsed"
  | (string & {});

/** Why you labelled an account, as `reason_code` on a label. An open set. */
export type LabelReasonCode =
  | "high_volume_backend"
  | "batch_job"
  | "ci_automation"
  | "internal_service"
  | "reseller_partner"
  | "shared_team"
  | "travel"
  | "new_device"
  | "migration"
  | "other"
  | (string & {});

/** The browser sensor's verdict. An open set. */
export type SensorDecision = "allow" | "challenge" | "deny" | (string & {});
