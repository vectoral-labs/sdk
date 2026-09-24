// Form-fill telemetry. `pasted` is the valuable bit: scripted fills paste,
// humans type. `corrections` counts backspaces and edits — humans make them,
// scripts do not.
//
// Omitting the block gates these checks off server-side entirely; it is never
// read as a clean fill, so a partial integration is not penalised.

export interface FormFieldTelemetry {
  pasted: boolean;
  keystrokes: number;
  corrections: number;
  focus_ms: number;
}

export interface FormTelemetrySnapshot {
  load_to_submit_ms: number;
  fields: Record<string, FormFieldTelemetry>;
}

export interface FormTelemetryOptions {
  /** Clock, in ms since page load. Defaults to `performance.now()`. */
  now?: () => number;
  /**
   * Field names to report. When omitted, every field that received an event is
   * reported. Never include a field whose NAME would reveal something you would
   * not log — only names are sent, never values.
   */
  fields?: string[];
}

interface FieldState {
  pasted: boolean;
  keystrokes: number;
  corrections: number;
  focusMs: number;
  focusedAt: number | null;
}

const newField = (): FieldState => ({
  pasted: false,
  keystrokes: 0,
  corrections: 0,
  focusMs: 0,
  focusedAt: null,
});

/** Keys that edit rather than add. */
const CORRECTION_KEYS = new Set(["Backspace", "Delete", "Undo"]);

/** Keys that produce no character and should not count as a keystroke. */
const NON_TYPING_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "Tab",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

/**
 * Accumulates fill behaviour for one form. Transport-free and DOM-free so it
 * can be driven directly — `trackForm()` is the thin DOM wiring over it.
 */
export class FormTelemetry {
  private readonly fields = new Map<string, FieldState>();
  private readonly now: () => number;
  private readonly allowed: Set<string> | null;

  constructor(opts: FormTelemetryOptions = {}) {
    this.now =
      opts.now ??
      (() => {
        const p = (globalThis as { performance?: { now(): number } }).performance;
        return p ? p.now() : 0;
      });
    this.allowed = opts.fields ? new Set(opts.fields) : null;
  }

  private state(field: string): FieldState | null {
    if (this.allowed && !this.allowed.has(field)) return null;
    let s = this.fields.get(field);
    if (!s) {
      s = newField();
      this.fields.set(field, s);
    }
    return s;
  }

  focus(field: string): void {
    const s = this.state(field);
    if (s && s.focusedAt === null) s.focusedAt = this.now();
  }

  blur(field: string): void {
    const s = this.state(field);
    if (!s || s.focusedAt === null) return;
    s.focusMs += this.now() - s.focusedAt;
    s.focusedAt = null;
  }

  keystroke(field: string, key: string): void {
    const s = this.state(field);
    if (!s) return;
    if (CORRECTION_KEYS.has(key)) {
      s.corrections += 1;
      return;
    }
    if (NON_TYPING_KEYS.has(key)) return;
    s.keystrokes += 1;
  }

  paste(field: string): void {
    const s = this.state(field);
    if (s) s.pasted = true;
  }

  /**
   * Current telemetry. Call at submit. Fields still focused have their
   * in-progress focus time included without ending the focus, so calling this
   * twice is safe.
   */
  snapshot(): FormTelemetrySnapshot {
    const t = this.now();
    const fields: Record<string, FormFieldTelemetry> = {};
    for (const [name, s] of this.fields) {
      const live = s.focusedAt === null ? 0 : t - s.focusedAt;
      fields[name] = {
        pasted: s.pasted,
        keystrokes: s.keystrokes,
        corrections: s.corrections,
        focus_ms: Math.round(s.focusMs + live),
      };
    }
    return { load_to_submit_ms: Math.round(t), fields };
  }
}

interface ListenerTarget {
  addEventListener(
    type: string,
    listener: (e: never) => void,
    options?: { capture?: boolean; passive?: boolean },
  ): void;
  removeEventListener(type: string, listener: (e: never) => void, options?: unknown): void;
}

export interface FormTracker {
  /** Telemetry so far. Call at submit and send it as the `form` block. */
  snapshot(): FormTelemetrySnapshot;
  /** Detach listeners. Safe to call twice. */
  stop(): void;
}

/**
 * `type` values that make an element a control rather than a field.
 *
 * Controls take focus and receive key events like anything else on the form, so
 * without this they arrive as fill telemetry. The submit button is the one that
 * shows up in practice: it usually has no `name` and no `id`, so it fell through
 * the name → id → type chain and reported itself as a field literally called
 * "submit", with `keystrokes: 0` and `pasted: false` — a non-fill control
 * indistinguishable, in the payload, from a field a script had pasted into.
 *
 * Matched on `type` rather than `tagName` because that covers both spellings of
 * the same control: `<button>` reports `type === "submit"` by default, and
 * `<input type="submit">` reports it explicitly. `image` is the third spelling
 * — `<input type="image">` is a submit button drawn as a picture. An
 * `<input name="submit">` is still a text field, reports `type === "text"`, and
 * is still tracked.
 */
const CONTROL_TYPES = new Set(["submit", "button", "reset", "image"]);

/**
 * Attach fill tracking to a form.
 *
 * Only field NAMES and the counts above are recorded — never values. Listeners
 * are passive and capturing, so they never block typing.
 *
 * Buttons are not fields: submit, reset, plain and image buttons are skipped, so
 * they never appear in `fields`. For tighter control over what is reported, pass
 * an explicit `fields` allowlist.
 *
 * ```js
 * const tracker = trackForm(document.querySelector("#signup"));
 * // at submit:
 * body.form = tracker.snapshot();
 * ```
 */
export function trackForm(
  form: ListenerTarget,
  opts: FormTelemetryOptions = {},
): FormTracker {
  const telemetry = new FormTelemetry(opts);
  const nameOf = (e: { target?: unknown }): string | null => {
    const t = e.target as { name?: string; id?: string; type?: string } | null;
    if (!t) return null;
    // Before naming it: is this a field at all? Checked first so a control is
    // dropped however it is named — a submit button carrying a `name` is still
    // not something a human fills in.
    if (typeof t.type === "string" && CONTROL_TYPES.has(t.type)) return null;
    return t.name || t.id || t.type || null;
  };

  const onFocus = (e: never): void => {
    const n = nameOf(e);
    if (n) telemetry.focus(n);
  };
  const onBlur = (e: never): void => {
    const n = nameOf(e);
    if (n) telemetry.blur(n);
  };
  const onKeyDown = (e: never): void => {
    const n = nameOf(e);
    if (n) telemetry.keystroke(n, (e as { key?: string }).key ?? "");
  };
  const onPaste = (e: never): void => {
    const n = nameOf(e);
    if (n) telemetry.paste(n);
  };
  const onInput = (e: never): void => {
    // Covers paste via context menu and programmatic insertion that does not
    // raise a `paste` event.
    if ((e as { inputType?: string }).inputType === "insertFromPaste") {
      const n = nameOf(e);
      if (n) telemetry.paste(n);
    }
  };

  const opt = { capture: true, passive: true };
  const bound: [string, (e: never) => void][] = [
    ["focusin", onFocus],
    ["focusout", onBlur],
    ["keydown", onKeyDown],
    ["paste", onPaste],
    ["input", onInput],
  ];
  for (const [type, fn] of bound) form.addEventListener(type, fn, opt);

  let stopped = false;
  return {
    snapshot: () => telemetry.snapshot(),
    stop: () => {
      if (stopped) return;
      stopped = true;
      for (const [type, fn] of bound) form.removeEventListener(type, fn, opt);
    },
  };
}
