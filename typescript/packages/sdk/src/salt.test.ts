import { describe, it, expect, afterEach } from "vitest";
import {
  resolveFingerprintConfig,
  generateSalt,
  suggestSaltId,
  MIN_SALT_LENGTH,
} from "./salt.js";
import { VectoralConfigError } from "./errors.js";

const GOOD_SALT = "9f".repeat(20);

afterEach(() => {
  delete process.env.VECTORAL_FINGERPRINT_SALT;
  delete process.env.VECTORAL_FINGERPRINT_SALT_ID;
});

describe("resolveFingerprintConfig", () => {
  it("is inert when not enabled", () => {
    expect(resolveFingerprintConfig(undefined).config).toBeNull();
    expect(resolveFingerprintConfig({ enabled: false }).config).toBeNull();
  });

  it("throws only for shareGlobal without enabled", () => {
    expect(() => resolveFingerprintConfig({ enabled: false, shareGlobal: true })).toThrow(
      VectoralConfigError,
    );
  });

  it("falls back to the environment", () => {
    process.env.VECTORAL_FINGERPRINT_SALT = GOOD_SALT;
    process.env.VECTORAL_FINGERPRINT_SALT_ID = "s_2026_09";
    const { config, warnings } = resolveFingerprintConfig({ enabled: true });
    expect(config).toEqual({
      salt: GOOD_SALT,
      saltId: "s_2026_09",
      shareGlobal: false,
    });
    expect(warnings).toEqual([]);
  });

  it("disables with a warning rather than throwing when the salt is missing", () => {
    const { config, warnings } = resolveFingerprintConfig({ enabled: true });
    expect(config).toBeNull();
    expect(warnings[0]).toMatch(/salt\/saltId are missing/);
  });

  it("rejects a short salt", () => {
    const { config, warnings } = resolveFingerprintConfig({
      enabled: true,
      salt: "abc123",
      saltId: "s1",
    });
    expect(config).toBeNull();
    expect(warnings[0]).toMatch(new RegExp(`${MIN_SALT_LENGTH}`));
  });

  it("rejects a well-known placeholder salt", () => {
    const { config, warnings } = resolveFingerprintConfig({
      enabled: true,
      salt: "ChangeMe",
      saltId: "s1",
    });
    expect(config).toBeNull();
    expect(warnings[0]).toMatch(/placeholder/);
  });
});

describe("generateSalt", () => {
  it("produces 64 hex chars, above the minimum length", () => {
    const s = generateSalt();
    expect(s).toMatch(/^[0-9a-f]{64}$/);
    expect(s.length).toBeGreaterThanOrEqual(MIN_SALT_LENGTH);
  });

  it("does not repeat", () => {
    expect(generateSalt()).not.toBe(generateSalt());
  });

  it("is accepted by the resolver", () => {
    const { config } = resolveFingerprintConfig({
      enabled: true,
      salt: generateSalt(),
      saltId: suggestSaltId(),
    });
    expect(config).not.toBeNull();
  });
});

describe("suggestSaltId", () => {
  it("formats the UTC year and month", () => {
    expect(suggestSaltId(new Date("2026-09-15T00:00:00Z"))).toBe("s_2026_09");
    expect(suggestSaltId(new Date("2026-01-01T00:00:00Z"))).toBe("s_2026_01");
  });
});
