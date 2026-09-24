// @vectoral-labs/browser — browser-side signal collection for Vectoral.
//
//   deviceFingerprint()  a stable, tenant-scoped id for this browser
//   detectAutomation()   automation tells + an environment-inconsistency score
//   trackForm()          fill telemetry: pasted / keystrokes / corrections
//   signupSignals()      all three, shaped for the registration endpoint
//
// This package holds NO secrets: the only credential it takes is your
// publishable site key, which salts the device fingerprint so values are scoped
// to your tenant. It never talks to Vectoral — post its output to your own
// backend and forward it from there with @vectoral-labs/sdk.

export { deviceFingerprint } from "./device.js";
export type { DeviceFingerprint, DeviceFingerprintOptions } from "./device.js";

export { detectAutomation } from "./automation.js";
export type { AutomationResult, DetectAutomationOptions } from "./automation.js";

export { trackForm, FormTelemetry } from "./form.js";
export type {
  FormTracker,
  FormTelemetryOptions,
  FormTelemetrySnapshot,
  FormFieldTelemetry,
} from "./form.js";

export { signupSignals } from "./signals.js";
export type { SignupSignals, SignupSignalsOptions } from "./signals.js";
