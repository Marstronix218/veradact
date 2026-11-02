import { describe, expect, it } from "vitest";
import { corePackageName } from "./index";

describe("@veradact/core", () => {
  it("exports its package name", () => {
    expect(corePackageName).toBe("@veradact/core");
  });
});
