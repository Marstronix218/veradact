import { describe, expect, it } from "vitest";
import { aiPackageName } from "./index";

describe("@veradact/ai", () => {
  it("exports its package name", () => {
    expect(aiPackageName).toBe("@veradact/ai");
  });
});
