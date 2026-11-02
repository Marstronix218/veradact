import { describe, expect, it } from "vitest";
import {
  EVENT_TYPES,
  EventValidationError,
  eventPayloadSchemas,
  isEventType,
  OCCURRED_AT_EVENT_TYPES,
  parseEventDraft,
  type EventDraft,
} from "./events";
import { sha256Hex } from "./hash";
import { LogBuilder, testUuid } from "./testing/log-builder";

const user = { type: "user" as const, id: testUuid("u") };
const hex = sha256Hex("x");

function fullLog() {
  const b = new LogBuilder()
    .engagement()
    .updateEngagement({ name: "Renamed" })
    .source("s1")
    .create("c1", "constraint", "Data stays in the EU", { spans: [{ source: "s1", start: 0, end: 10 }] })
    .create("r1", "requirement", "Nightly export", { dependsOn: ["c1"] })
    .revise("c1", "Data stays in the EU region", { reason: "correction" })
    .addDep("r1", "c1")
    .removeDep("r1", "c1")
    .clearReview("r1")
    .request("q1", ["c1", "r1"], ["alice"])
    .authorize("alice", "q1", false)
    .authorize("alice", "q1")
    .confirm("c1", "alice", "q1")
    .dispute("r1", "alice", "q1")
    .revoke("q1", null)
    .create("r2", "requirement", "Replacement")
    .supersede("r1", "r2")
    .withdraw("r2")
    .redact("s1")
    .eraseContact("alice");
  return b.log;
}

describe("event schemas", () => {
  it("define every event type of ARCHITECTURE §3", () => {
    expect(EVENT_TYPES).toEqual([
      "engagement_created",
      "engagement_updated",
      "source_ingested",
      "source_redacted",
      "item_created",
      "item_revised",
      "item_superseded",
      "item_withdrawn",
      "dependency_added",
      "dependency_removed",
      "review_cleared",
      "confirmation_requested",
      "confirmation_revoked",
      "authorization_granted",
      "authorization_declined",
      "item_confirmed",
      "item_disputed",
      "contact_erased",
    ]);
    expect(isEventType("item_created")).toBe(true);
    expect(isEventType("item_proposed")).toBe(false);
    expect(isEventType("toString")).toBe(false);
    expect([...OCCURRED_AT_EVENT_TYPES].sort()).toEqual(["item_created", "item_revised", "source_ingested"]);
  });

  it("accept every event a well-formed log contains", () => {
    const log = fullLog();
    expect(new Set(log.map((e) => e.type))).toEqual(new Set(EVENT_TYPES));
    for (const e of log) {
      const draft = parseEventDraft(e);
      expect(draft.payload).toEqual(e.payload);
      expect(eventPayloadSchemas[e.type].safeParse(e.payload).success).toBe(true);
    }
  });

  it("reject unknown keys (no PII can sneak in)", () => {
    expect(() =>
      parseEventDraft({ type: "contact_erased", actor: user, payload: { contact_id: testUuid("c"), email: "a@b.c" } }),
    ).toThrow(EventValidationError);
  });

  it("reject floats, uppercase ids and malformed hashes", () => {
    const base = {
      item_id: testUuid("i"),
      version: 1,
      content_hash: hex,
      contact_id: testUuid("c"),
      request_id: testUuid("r"),
      submission_id: testUuid("s"),
      channel: "email_link",
      evidence_commitment: hex,
    };
    const contact = { type: "contact" as const, id: base.contact_id };
    expect(() => parseEventDraft({ type: "item_confirmed", actor: contact, payload: base })).not.toThrow();
    expect(() => parseEventDraft({ type: "item_confirmed", actor: contact, payload: { ...base, version: 1.5 } })).toThrow(/version/);
    expect(() =>
      parseEventDraft({ type: "item_confirmed", actor: contact, payload: { ...base, item_id: base.item_id.toUpperCase() } }),
    ).toThrow(/item_id/);
    expect(() => parseEventDraft({ type: "item_confirmed", actor: contact, payload: { ...base, content_hash: "abc" } })).toThrow();
  });

  it("enforce sourced-or-manual on item versions", () => {
    const payload = {
      item_id: testUuid("i"),
      short_id: "HALV-R1",
      kind: "requirement",
      version: 1,
      statement: "Nightly export",
      spans: [],
      manual: null,
      depends_on: [],
      provenance: { via: "manual" },
      content_hash: hex,
    };
    expect(() => parseEventDraft({ type: "item_created", actor: user, payload })).toThrow(/spans or manual/);
    const span = { source_id: testUuid("s"), source_sha256: hex, start: 0, end: 4 };
    expect(() =>
      parseEventDraft({ type: "item_created", actor: user, payload: { ...payload, spans: [span], manual: { entered_by: user.id } } }),
    ).toThrow(/spans or manual/);
    expect(() => parseEventDraft({ type: "item_created", actor: user, payload: { ...payload, spans: [span] } })).not.toThrow();
    expect(() =>
      parseEventDraft({ type: "item_created", actor: user, payload: { ...payload, spans: [{ ...span, end: 0 }] } }),
    ).toThrow(/end/);
  });

  it("reject text Postgres jsonb cannot store and blank statements", () => {
    const payload = {
      item_id: testUuid("i"),
      short_id: "HALV-R1",
      kind: "requirement",
      version: 1,
      statement: "ok",
      spans: [],
      manual: { entered_by: user.id },
      depends_on: [],
      provenance: { via: "manual" },
      content_hash: hex,
    };
    for (const statement of ["a\u0000b", "lone \uD800 surrogate", "   ", ""]) {
      expect(() => parseEventDraft({ type: "item_created", actor: user, payload: { ...payload, statement } })).toThrow();
    }
    expect(() => parseEventDraft({ type: "item_created", actor: user, payload: { ...payload, statement: "emoji 🚚 ok" } })).not.toThrow();
  });

  it("require ISO millisecond UTC timestamps in payloads", () => {
    const payload = {
      request_id: testUuid("r"),
      items: [{ item_id: testUuid("i"), version: 1, content_hash: hex }],
      contact_ids: [testUuid("c")],
      expires_at: "2026-03-16T15:00:00.000Z",
      channel: "email_link",
    };
    expect(() => parseEventDraft({ type: "confirmation_requested", actor: user, payload })).not.toThrow();
    for (const expires_at of ["2026-03-16T15:00:00Z", "2026-03-16T10:00:00.000-05:00", "2026-02-30T00:00:00.000Z"]) {
      expect(() => parseEventDraft({ type: "confirmation_requested", actor: user, payload: { ...payload, expires_at } })).toThrow();
    }
    expect(() =>
      parseEventDraft({ type: "confirmation_requested", actor: user, payload: { ...payload, contact_ids: [testUuid("c"), testUuid("c")] } }),
    ).toThrow(/once per request/);
  });

  it("enforce who may author each event type", () => {
    const contactId = testUuid("c");
    const auth = {
      contact_id: contactId,
      request_id: testUuid("r"),
      text_version: "v1",
      text: "I authorize",
      text_sha256: hex,
      evidence_commitment: hex,
    };
    expect(() => parseEventDraft({ type: "authorization_granted", actor: { type: "contact", id: contactId }, payload: auth })).not.toThrow();
    expect(() => parseEventDraft({ type: "authorization_granted", actor: user, payload: auth })).toThrow(/actor.type/);
    expect(() =>
      parseEventDraft({ type: "authorization_granted", actor: { type: "contact", id: testUuid("other") }, payload: auth }),
    ).toThrow(/contact named in the payload/);
    expect(() =>
      parseEventDraft({ type: "review_cleared", actor: { type: "contact", id: contactId }, payload: { item_id: testUuid("i") } }),
    ).toThrow(/actor.type/);
    expect(() => parseEventDraft({ type: "review_cleared", actor: { type: "system", id: null }, payload: { item_id: testUuid("i") } })).toThrow(
      /actor.type/,
    );
    expect(() =>
      parseEventDraft({ type: "source_redacted", actor: { type: "system", id: null }, payload: { source_id: testUuid("s"), reason_code: "retention" } }),
    ).not.toThrow();
  });

  it("validate actors", () => {
    const payload = { contact_id: testUuid("c") };
    expect(() => parseEventDraft({ type: "contact_erased", actor: { type: "system", id: null }, payload })).not.toThrow();
    expect(() => parseEventDraft({ type: "contact_erased", actor: { type: "system", id: testUuid("x") }, payload })).toThrow();
    expect(() => parseEventDraft({ type: "contact_erased", actor: { type: "user", id: null }, payload })).toThrow();
    expect(() => parseEventDraft({ type: "contact_erased", actor: { type: "robot", id: null }, payload })).toThrow();
  });

  it("drop undefined-valued keys, require at least one engagement_updated field", () => {
    const draft = parseEventDraft({
      type: "engagement_updated",
      actor: user,
      payload: { name: "New", client_name: undefined },
    });
    expect(Object.keys(draft.payload)).toEqual(["name"]);
    expect(() => parseEventDraft({ type: "engagement_updated", actor: user, payload: { name: undefined } })).toThrow();
  });

  it("reject unknown types and invalid occurredAt, without echoing values", () => {
    expect(() => parseEventDraft({ type: "item_proposed", actor: user, payload: {} })).toThrow(/unknown event type/);
    expect(() =>
      parseEventDraft({ type: "contact_erased", actor: user, payload: { contact_id: testUuid("c") }, occurredAt: new Date(Number.NaN) }),
    ).toThrow(/occurredAt/);
    try {
      parseEventDraft({ type: "contact_erased", actor: user, payload: { contact_id: "jane@example.com" } });
    } catch (e) {
      expect((e as Error).message).not.toContain("jane");
    }
  });

  it("copy occurredAt", () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    const draft: EventDraft = parseEventDraft({ type: "contact_erased", actor: user, payload: { contact_id: testUuid("c") }, occurredAt: at });
    expect(draft.occurredAt).toEqual(at);
    expect(draft.occurredAt).not.toBe(at);
  });
});
