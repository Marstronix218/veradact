import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical";
import { assertSourcedOrManual, isSourcedOrManual, itemContentHash, SourcedOrManualError, type ItemContentFields } from "./content-hash";
import { sha256Hex } from "./hash";
import { testUuid } from "./testing/log-builder";

const span = { source_id: testUuid("s"), source_sha256: sha256Hex("text"), start: 3, end: 9 };
const fields: ItemContentFields = {
  engagement_id: testUuid("e"),
  item_id: testUuid("i"),
  kind: "requirement",
  version: 1,
  statement: "Nightly export to the data lake",
  spans: [span],
  manual: null,
};

describe("itemContentHash", () => {
  it("is sha256 of the canonical content object", () => {
    const expected = sha256Hex(
      canonicalJson({
        engagement_id: fields.engagement_id,
        item_id: fields.item_id,
        kind: "requirement",
        version: 1,
        statement: fields.statement,
        spans: [span],
        manual: null,
      }),
    );
    expect(itemContentHash(fields)).toBe(expected);
  });

  it("binds version, item, engagement, kind, statement, spans and manual", () => {
    const h = itemContentHash(fields);
    const variants: Partial<ItemContentFields>[] = [
      { version: 2 },
      { item_id: testUuid("other") },
      { engagement_id: testUuid("other") },
      { kind: "decision" },
      { statement: `${fields.statement}.` },
      { spans: [{ ...span, end: 10 }] },
      { spans: [{ ...span, source_sha256: sha256Hex("edited text") }] },
      { spans: [], manual: { entered_by: testUuid("u") } },
    ];
    for (const v of variants) expect(itemContentHash({ ...fields, ...v })).not.toBe(h);
  });

  it("ignores projection-only span fields such as carried", () => {
    const withCarried = { ...span, carried: true } as typeof span;
    expect(itemContentHash({ ...fields, spans: [withCarried] })).toBe(itemContentHash(fields));
  });
});

describe("sourced-or-manual", () => {
  it("accepts spans XOR manual", () => {
    expect(isSourcedOrManual([span], null)).toBe(true);
    expect(isSourcedOrManual([], { entered_by: testUuid("u") })).toBe(true);
    expect(() => assertSourcedOrManual([span], null)).not.toThrow();
    expect(() => assertSourcedOrManual([], { entered_by: testUuid("u") })).not.toThrow();
  });

  it("rejects neither and both", () => {
    expect(isSourcedOrManual([], null)).toBe(false);
    expect(isSourcedOrManual([span], { entered_by: testUuid("u") })).toBe(false);
    expect(() => assertSourcedOrManual([], null)).toThrow(SourcedOrManualError);
    expect(() => assertSourcedOrManual([], undefined)).toThrow(/at least one source span/);
    expect(() => assertSourcedOrManual([span], { entered_by: testUuid("u") })).toThrow(/both/);
  });
});
