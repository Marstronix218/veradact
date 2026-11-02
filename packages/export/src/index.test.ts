import { describe, expect, it } from "vitest";
import { exportPackageName } from "./index";

describe("@veradact/export", () => {
  it("exports its package name", () => {
    expect(exportPackageName).toBe("@veradact/export");
  });
});
