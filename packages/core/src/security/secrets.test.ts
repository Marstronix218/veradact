import { describe, expect, it } from "vitest";
import { assertProductionSecrets, unsafeProductionSecrets } from "./secrets";

const STRONG = {
  SESSION_SECRET: "q3Vh0m8m2Yb7vXk1Zr9pT4sWc6nLd5aJ",
  LINK_SIGNING_SECRET: "Jt5Q9wz1nXk3c7Vb0Rm2Ys8Lp4Hd6Fa+",
  CRON_SECRET: "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1eF",
};
// The values shipped in .env.example.
const PLACEHOLDERS = {
  SESSION_SECRET: "dev-only-change-me-session-secret-000000",
  LINK_SIGNING_SECRET: "dev-only-change-me-link-secret-0000000",
  CRON_SECRET: "dev-only-change-me-cron-secret",
};

describe("production secrets", () => {
  it("accepts strong secrets in production and ignores everything outside production", () => {
    expect(unsafeProductionSecrets({ NODE_ENV: "production", ...STRONG })).toEqual([]);
    expect(() => assertProductionSecrets({ NODE_ENV: "production", ...STRONG })).not.toThrow();
    expect(unsafeProductionSecrets({ NODE_ENV: "development", ...PLACEHOLDERS })).toEqual([]);
    expect(unsafeProductionSecrets({})).toEqual([]);
  });

  it("refuses the .env.example placeholders and short values, naming the variables but not the values", () => {
    expect(unsafeProductionSecrets({ NODE_ENV: "production", ...PLACEHOLDERS })).toEqual(["SESSION_SECRET", "LINK_SIGNING_SECRET", "CRON_SECRET"]);
    expect(unsafeProductionSecrets({ NODE_ENV: "production", ...STRONG, CRON_SECRET: "short" })).toEqual(["CRON_SECRET"]);
    expect(unsafeProductionSecrets({ NODE_ENV: "production", ...STRONG, SESSION_SECRET: "please-CHANGEME-0123456789abcdefghij" })).toEqual(["SESSION_SECRET"]);
    expect(unsafeProductionSecrets({ NODE_ENV: "production", ...STRONG, LINK_SIGNING_SECRET: "dev-only-but-long-enough-0123456789abcdef" })).toEqual(["LINK_SIGNING_SECRET"]);
    let message = "";
    try {
      assertProductionSecrets({ NODE_ENV: "production", ...PLACEHOLDERS });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^Refusing to start in production: SESSION_SECRET, LINK_SIGNING_SECRET, CRON_SECRET must be set/);
    for (const value of Object.values(PLACEHOLDERS)) expect(message).not.toContain(value);
  });

  it("requires LINK_SIGNING_SECRET; the others may be unset", () => {
    expect(unsafeProductionSecrets({ NODE_ENV: "production", LINK_SIGNING_SECRET: STRONG.LINK_SIGNING_SECRET })).toEqual([]);
    expect(unsafeProductionSecrets({ NODE_ENV: "production", SESSION_SECRET: STRONG.SESSION_SECRET, CRON_SECRET: " " })).toEqual(["LINK_SIGNING_SECRET"]);
  });
});
