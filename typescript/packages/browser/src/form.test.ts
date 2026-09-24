import { describe, it, expect } from "vitest";
import { FormTelemetry, trackForm } from "./form.js";

/** Controllable clock so focus_ms is deterministic. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 0;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

describe("FormTelemetry", () => {
  it("separates typing from corrections", () => {
    const t = new FormTelemetry({ now: () => 0 });
    for (const k of ["a", "b", "c"]) t.keystroke("email", k);
    t.keystroke("email", "Backspace");
    t.keystroke("email", "Delete");
    const f = t.snapshot().fields["email"]!;
    expect(f.keystrokes).toBe(3);
    expect(f.corrections).toBe(2);
  });

  it("ignores modifier and navigation keys", () => {
    const t = new FormTelemetry({ now: () => 0 });
    for (const k of ["Shift", "Control", "Tab", "ArrowLeft", "Meta"]) {
      t.keystroke("email", k);
    }
    expect(t.snapshot().fields["email"]!.keystrokes).toBe(0);
  });

  it("records a paste — the tell that a script filled the field", () => {
    const t = new FormTelemetry({ now: () => 0 });
    t.paste("password");
    const f = t.snapshot().fields["password"]!;
    expect(f.pasted).toBe(true);
    expect(f.keystrokes).toBe(0);
  });

  it("accumulates focus across visits", () => {
    const c = clock();
    const t = new FormTelemetry({ now: c.now });
    t.focus("email");
    c.advance(1200);
    t.blur("email");
    c.advance(5000); // elsewhere on the page
    t.focus("email");
    c.advance(300);
    t.blur("email");
    expect(t.snapshot().fields["email"]!.focus_ms).toBe(1500);
  });

  it("includes in-progress focus without ending it, so snapshot is repeatable", () => {
    const c = clock();
    const t = new FormTelemetry({ now: c.now });
    t.focus("email");
    c.advance(400);
    expect(t.snapshot().fields["email"]!.focus_ms).toBe(400);
    c.advance(600);
    expect(t.snapshot().fields["email"]!.focus_ms).toBe(1000);
  });

  it("reports load_to_submit_ms from the page clock", () => {
    const c = clock();
    const t = new FormTelemetry({ now: c.now });
    c.advance(8400);
    expect(t.snapshot().load_to_submit_ms).toBe(8400);
  });

  it("drops fields outside an explicit allowlist", () => {
    const t = new FormTelemetry({ now: () => 0, fields: ["email"] });
    t.keystroke("email", "a");
    t.keystroke("credit_card", "4");
    const fields = t.snapshot().fields;
    expect(Object.keys(fields)).toEqual(["email"]);
  });

  it("reports nothing for a form nobody touched", () => {
    const t = new FormTelemetry({ now: () => 0 });
    expect(t.snapshot().fields).toEqual({});
  });
});

/** Minimal event-target stand-in; no jsdom required. */
function fakeForm() {
  const listeners = new Map<string, ((e: unknown) => void)[]>();
  return {
    addEventListener(type: string, fn: (e: never) => void) {
      const l = listeners.get(type) ?? [];
      l.push(fn as (e: unknown) => void);
      listeners.set(type, l);
    },
    removeEventListener(type: string, fn: (e: never) => void) {
      const l = listeners.get(type) ?? [];
      listeners.set(
        type,
        l.filter((f) => f !== fn),
      );
    },
    fire(type: string, event: unknown) {
      for (const fn of listeners.get(type) ?? []) fn(event);
    },
    count(type: string) {
      return (listeners.get(type) ?? []).length;
    },
  };
}

describe("trackForm", () => {
  it("names fields by name, then id, then type", () => {
    const form = fakeForm();
    const tracker = trackForm(form, { now: () => 0 });
    form.fire("keydown", { target: { name: "email" }, key: "a" });
    form.fire("keydown", { target: { id: "pw" }, key: "b" });
    form.fire("keydown", { target: { type: "checkbox" }, key: "c" });
    expect(Object.keys(tracker.snapshot().fields).sort()).toEqual([
      "checkbox",
      "email",
      "pw",
    ]);
  });

  it("skips buttons, which take focus but are not fields", () => {
    const form = fakeForm();
    const tracker = trackForm(form, { now: () => 0 });
    // How it reaches us in practice: no name, no id, so the name chain would
    // have fallen through to `type` and reported a field called "submit".
    form.fire("focusin", { target: { type: "submit" } });
    form.fire("keydown", { target: { type: "submit" }, key: "Enter" });
    // A <button> defaults to type="submit"; type="button" and "reset" too.
    form.fire("keydown", { target: { name: "save", type: "button" }, key: "a" });
    form.fire("keydown", { target: { id: "clear", type: "reset" }, key: "a" });
    expect(tracker.snapshot().fields).toEqual({});
  });

  it("still tracks a text field that happens to be named submit", () => {
    const form = fakeForm();
    const tracker = trackForm(form, { now: () => 0 });
    form.fire("keydown", { target: { name: "submit", type: "text" }, key: "a" });
    expect(tracker.snapshot().fields["submit"]!.keystrokes).toBe(1);
  });

  it("treats an insertFromPaste input event as a paste", () => {
    const form = fakeForm();
    const tracker = trackForm(form, { now: () => 0 });
    form.fire("input", { target: { name: "email" }, inputType: "insertFromPaste" });
    expect(tracker.snapshot().fields["email"]!.pasted).toBe(true);
  });

  it("ignores ordinary input events", () => {
    const form = fakeForm();
    const tracker = trackForm(form, { now: () => 0 });
    form.fire("input", { target: { name: "email" }, inputType: "insertText" });
    expect(tracker.snapshot().fields).toEqual({});
  });

  it("detaches on stop, and stop is idempotent", () => {
    const form = fakeForm();
    const tracker = trackForm(form, { now: () => 0 });
    expect(form.count("keydown")).toBe(1);
    tracker.stop();
    tracker.stop();
    expect(form.count("keydown")).toBe(0);
    form.fire("keydown", { target: { name: "email" }, key: "a" });
    expect(tracker.snapshot().fields).toEqual({});
  });
});
