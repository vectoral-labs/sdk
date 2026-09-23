// Bundle entry for the standalone <script> build. Everything testable lives in
// `standalone.ts`; this file exists only so the IIFE has a side effect to run.
// The npm entry (`index.ts`) stays side-effect free.

import { install } from "./standalone.js";
import { hasDom } from "./env.js";

if (hasDom()) install();
