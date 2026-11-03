import { describe, expect, it } from "vitest";
import { demoLoginPassword, isDemoAddress, isDemoLoginEnabled } from "./demo-login";

describe("demo login config", () => {
  it("is off unless DEMO_LOGIN_PASSWORD has at least 8 characters", () => {
    expect(isDemoLoginEnabled({})).toBe(false);
    expect(isDemoLoginEnabled({ DEMO_LOGIN_PASSWORD: "" })).toBe(false);
    expect(isDemoLoginEnabled({ DEMO_LOGIN_PASSWORD: "  short  " })).toBe(false);
    expect(demoLoginPassword({ DEMO_LOGIN_PASSWORD: " quillfield-demo\n" })).toBe("quillfield-demo");
  });

  it("is always off in production", () => {
    expect(isDemoLoginEnabled({ NODE_ENV: "production", DEMO_LOGIN_PASSWORD: "a-long-demo-password" })).toBe(false);
  });

  it("only accepts addresses under the reserved .example TLD", () => {
    expect(isDemoAddress("admin@quillfield.example")).toBe(true);
    expect(isDemoAddress("a@b.c.example")).toBe(true);
    expect(isDemoAddress("ada@example.com")).toBe(false);
    expect(isDemoAddress("ada@example.test")).toBe(false);
    expect(isDemoAddress("ada@quillfield.example.com")).toBe(false);
    expect(isDemoAddress("ada@notexample")).toBe(false);
    expect(isDemoAddress("quillfield.example")).toBe(false);
    expect(isDemoAddress("a@b@quillfield.example")).toBe(false);
    expect(isDemoAddress("@quillfield.example")).toBe(false);
  });
});
