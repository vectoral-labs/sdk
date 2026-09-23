// Environment probing. Every probe is wrapped: a fingerprint that throws in a
// hardened browser is worse than one with a missing component.

export const safe = <T>(fn: () => T, fallback: T): T => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

export interface UserAgentData {
  brands?: { brand: string; version: string }[];
  mobile?: boolean;
  platform?: string;
}

interface NavigatorLike {
  userAgent?: string;
  userAgentData?: UserAgentData;
  platform?: string;
  language?: string;
  languages?: readonly string[];
  hardwareConcurrency?: number;
  deviceMemory?: number;
  maxTouchPoints?: number;
  webdriver?: boolean;
  plugins?: { length: number };
  cookieEnabled?: boolean;
  permissions?: unknown;
}

export const nav = (): NavigatorLike =>
  (globalThis as { navigator?: NavigatorLike }).navigator ?? {};

export const win = (): Record<string, unknown> =>
  globalThis as unknown as Record<string, unknown>;

export const doc = (): Document | undefined =>
  (globalThis as { document?: Document }).document;

/** Is there enough of a DOM to collect anything at all? */
export const hasDom = (): boolean =>
  typeof globalThis === "object" && doc() !== undefined;

export interface ScreenInfo {
  width: number;
  height: number;
  colorDepth: number;
}

export const screenInfo = (): ScreenInfo =>
  safe(
    () => {
      const s = (globalThis as { screen?: Screen }).screen;
      return {
        width: s?.width ?? 0,
        height: s?.height ?? 0,
        colorDepth: s?.colorDepth ?? 0,
      };
    },
    { width: 0, height: 0, colorDepth: 0 },
  );

export const timezone = (): string | null =>
  safe(() => Intl.DateTimeFormat().resolvedOptions().timeZone ?? null, null);

export interface WebglInfo {
  vendor: string | null;
  renderer: string | null;
}

export const webglInfo = (): WebglInfo | null =>
  safe(() => {
    const d = doc();
    if (!d) return null;
    const c = d.createElement("canvas");
    const gl = (c.getContext("webgl") ??
      c.getContext("experimental-webgl")) as WebGLRenderingContext | null;
    if (!gl) return null;
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    if (!dbg) return { vendor: null, renderer: null };
    return {
      vendor: String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) ?? ""),
      renderer: String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? ""),
    };
  }, null);

/**
 * A canvas rendering, as a data URL. The caller hashes it — we return the raw
 * string so the whole fingerprint goes through one salted digest rather than
 * leaking a second, unsalted one.
 */
export const canvasSample = (): string | null =>
  safe(() => {
    const d = doc();
    if (!d) return null;
    const c = d.createElement("canvas");
    c.width = 240;
    c.height = 60;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.textBaseline = "top";
    ctx.font = "14px 'Arial'";
    ctx.fillStyle = "#f60";
    ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = "#069";
    ctx.fillText("Vectoral ⚡ sensor", 2, 15);
    ctx.fillStyle = "rgba(102,204,0,0.7)";
    ctx.fillText("Vectoral ⚡ sensor", 4, 17);
    return c.toDataURL();
  }, null);
