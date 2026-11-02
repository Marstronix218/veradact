import { describe, expect, it } from "vitest";
import { ingestPackageName } from "./index";

describe("@veradact/ingest", () => {
  it("exports its package name", () => {
    expect(ingestPackageName).toBe("@veradact/ingest");
  });
});
