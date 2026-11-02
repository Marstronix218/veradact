import { describe, expect, it } from "vitest";
import { MockModelClient } from "./mock-client";
import { ModelClientError, type ExtractionInput, type RawCandidate } from "./model-client";
import { RecordedModelClient } from "./recorded-client";

const input = (sourceText: string): ExtractionInput => ({
  sourceText,
  sourceType: "human_notes",
  existingItems: [],
  promptVersion: "extract.v1",
});

const cand: RawCandidate = {
  kind: "decision",
  statement: "Start with LLC applications.",
  quote: "start with LLC applications",
  start: 0,
  end: 27,
  speaker_label: null,
  confidence: 0.9,
  suggested_depends_on: [],
  revises: null,
};

describe("MockModelClient", () => {
  it("starts at zero calls and counts every extract()", async () => {
    const mock = new MockModelClient();
    expect(mock.calls).toBe(0);
    expect(mock.callLog).toEqual([]);
    await mock.extract(input("a"));
    await mock.extract(input("b"));
    expect(mock.calls).toBe(2);
    expect(mock.callLog.map((c) => c.sourceText)).toEqual(["a", "b"]);
  });

  it("replays scripted responses in order, throws scripted errors, then returns []", async () => {
    const mock = new MockModelClient([[cand], new ModelClientError("rate_limited"), (i, n) => [{ ...cand, statement: `${i.sourceText}#${n}` }]]);
    await expect(mock.extract(input("x"))).resolves.toEqual([cand]);
    await expect(mock.extract(input("x"))).rejects.toMatchObject({ code: "rate_limited" });
    await expect(mock.extract(input("y"))).resolves.toMatchObject([{ statement: "y#2" }]);
    await expect(mock.extract(input("z"))).resolves.toEqual([]);
    expect(mock.calls).toBe(4);
  });

  it("returns copies, so callers cannot mutate the script", async () => {
    const mock = new MockModelClient([[cand]]);
    const [first] = await mock.extract(input("x"));
    first?.suggested_depends_on.push("#9");
    expect(cand.suggested_depends_on).toEqual([]);
  });
});

describe("RecordedModelClient", () => {
  it("answers by exact source text and refuses unknown text", async () => {
    const rec = new RecordedModelClient([{ sourceText: "we agreed to start with LLC applications", candidates: [cand] }]);
    expect(rec.name).toBe("recorded");
    await expect(rec.extract(input("we agreed to start with LLC applications"))).resolves.toEqual([cand]);
    await expect(rec.extract(input("something else"))).rejects.toMatchObject({ code: "no_recording" });
  });

  it("validates recordings", () => {
    expect(() => new RecordedModelClient([{ sourceText: "x", candidates: [{ ...cand, start: 1.5 }] }])).toThrow();
  });
});
