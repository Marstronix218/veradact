import { afterEach, describe, expect, it, vi } from "vitest";
import { isCronAuthorized } from "./cron";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isCronAuthorized", () => {
  it("accepts only the configured bearer secret", () => {
    vi.stubEnv("CRON_SECRET", "cron-secret-for-tests-0123456789abcdef");
    expect(isCronAuthorized("Bearer cron-secret-for-tests-0123456789abcdef")).toBe(true);
    for (const header of [null, "", "cron-secret-for-tests-0123456789abcdef", "Bearer ", "Bearer cron-secret-for-tests", "Basic cron-secret-for-tests-0123456789abcdef"]) {
      expect(isCronAuthorized(header)).toBe(false);
    }
  });

  it("authorizes nothing when CRON_SECRET is unset or blank", () => {
    for (const value of ["", "   "]) {
      vi.stubEnv("CRON_SECRET", value);
      expect(isCronAuthorized("Bearer ")).toBe(false);
      expect(isCronAuthorized(`Bearer ${value}`)).toBe(false);
    }
  });

  it("refuses the .env.example placeholder in production", () => {
    vi.stubEnv("CRON_SECRET", "dev-only-change-me-cron-secret");
    expect(isCronAuthorized("Bearer dev-only-change-me-cron-secret")).toBe(true);
    vi.stubEnv("NODE_ENV", "production");
    expect(isCronAuthorized("Bearer dev-only-change-me-cron-secret")).toBe(false);
  });
});
