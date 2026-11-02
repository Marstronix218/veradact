import { describe, expect, it } from "vitest";
import { dbPackageName } from "./index";

describe("@veradact/db", () => {
  it("exports its package name", () => {
    expect(dbPackageName).toBe("@veradact/db");
  });
});
