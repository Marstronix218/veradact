import { describe, expect, it } from "vitest";
import { emailPackageName } from "./index";

describe("@veradact/email", () => {
  it("exports its package name", () => {
    expect(emailPackageName).toBe("@veradact/email");
  });
});
