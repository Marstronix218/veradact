import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { verifyChain } from "../chain";
import { isSourcedOrManual, itemContentHash } from "../content-hash";
import { canDependOn, wouldCreateCycle } from "../dependencies";
import { EVENT_TYPES, parseEventDraft, type Span, type StoredEvent } from "../events";
import { reduce } from "../reducer";
import { contactRevokedAt, currentVersionOf, emptyState, nextShortId, type EngagementState } from "../state";
import { arbStoredLog, chainDrafts, clockFrom, steppingClock, storedEventsOf } from "./arbitraries";

const sameSpan = (a: Span, b: Span) =>
  a.source_id === b.source_id && a.source_sha256 === b.source_sha256 && a.start === b.start && a.end === b.end;

/**
 * Checks one event against the state before it with the rules a correct command layer enforces
 * (ARCHITECTURE §5.2). Returns a list of violations (empty when valid).
 */
function violations(state: EngagementState, e: StoredEvent, prev: StoredEvent | undefined): string[] {
  const v: string[] = [];
  const need = (cond: boolean, msg: string) => {
    if (!cond) v.push(`seq ${e.seq} ${e.type}: ${msg}`);
  };
  if (e.seq === 1) need(e.type === "engagement_created", "genesis must be engagement_created");
  else need(e.type !== "engagement_created" && state.engagement !== null, "engagement_created only at seq 1");
  if (prev) need(e.recordedAt.getTime() >= prev.recordedAt.getTime(), "recorded_at went backwards");
  const engagementId = state.engagement?.id ?? (e.type === "engagement_created" ? e.payload.engagement_id : "");
  const activeItem = (id: string) => {
    const item = state.items.get(id);
    return item && item.lifecycle === "active" ? item : undefined;
  };
  const usableSpan = (s: Span) => {
    const src = state.sources.get(s.source_id);
    return src !== undefined && src.redacted === null && src.contentSha256 === s.source_sha256 && s.end <= src.charLength;
  };

  switch (e.type) {
    case "source_redacted":
      need(state.sources.get(e.payload.source_id)?.redacted === null, "source must exist and be unredacted");
      break;
    case "item_created": {
      const p = e.payload;
      need(!state.items.has(p.item_id), "item id reused");
      need(p.short_id === nextShortId(state, p.kind), "short id not allocated per kind");
      need(isSourcedOrManual(p.spans, p.manual), "sourced-or-manual");
      need(p.spans.every(usableSpan), "span must cite an unredacted source");
      need(p.depends_on.length === 0 || canDependOn(p.kind), "only decisions/requirements depend");
      need(p.depends_on.every((d) => activeItem(d) !== undefined), "dependency must be active");
      need(p.content_hash === itemContentHash({ engagement_id: engagementId, item_id: p.item_id, kind: p.kind, version: 1, statement: p.statement, spans: p.spans, manual: p.manual }), "content hash");
      break;
    }
    case "item_revised": {
      const p = e.payload;
      const item = activeItem(p.item_id);
      need(item !== undefined, "revise needs an active item");
      if (!item) break;
      const cur = currentVersionOf(item);
      need(p.version === cur.version + 1, "version must increase by one");
      need(p.previous_content_hash === cur.contentHash, "previous content hash");
      need(isSourcedOrManual(p.spans, p.manual), "sourced-or-manual");
      need(p.spans.every((s) => cur.spans.some((c) => sameSpan(c, s)) || usableSpan(s)), "new spans must cite unredacted sources");
      need(p.content_hash === itemContentHash({ engagement_id: engagementId, item_id: p.item_id, kind: item.kind, version: p.version, statement: p.statement, spans: p.spans, manual: p.manual }), "content hash");
      break;
    }
    case "item_superseded":
      need(activeItem(e.payload.item_id) !== undefined, "supersede needs an active item");
      need(activeItem(e.payload.superseded_by_item_id) !== undefined && e.payload.superseded_by_item_id !== e.payload.item_id, "superseding item must be another active item");
      break;
    case "item_withdrawn":
      need(activeItem(e.payload.item_id) !== undefined, "withdraw needs an active item");
      break;
    case "dependency_added": {
      const d = activeItem(e.payload.item_id);
      need(d !== undefined && canDependOn(d.kind), "dependent must be an active decision/requirement");
      need(activeItem(e.payload.depends_on_item_id) !== undefined, "upstream must be active");
      need(!d?.dependsOn.has(e.payload.depends_on_item_id), "duplicate dependency");
      need(!wouldCreateCycle(state, e.payload.item_id, e.payload.depends_on_item_id), "cycle");
      break;
    }
    case "dependency_removed":
      need(activeItem(e.payload.item_id)?.dependsOn.has(e.payload.depends_on_item_id) === true, "edge must exist");
      break;
    case "review_cleared":
      need(activeItem(e.payload.item_id)?.needsReview === true, "item must need review");
      break;
    case "confirmation_requested":
      need(!state.requests.has(e.payload.request_id), "request id reused");
      for (const ri of e.payload.items) {
        const item = activeItem(ri.item_id);
        need(item !== undefined && item.status !== "confirmed", "requested item must be active and not confirmed");
        if (item) need(currentVersionOf(item).version === ri.version && currentVersionOf(item).contentHash === ri.content_hash, "requested version must be current");
      }
      need(e.payload.contact_ids.every((c) => !state.erasedContacts.has(c)), "erased contact requested");
      need(new Date(e.payload.expires_at).getTime() > e.recordedAt.getTime(), "expires in the past");
      break;
    case "confirmation_revoked": {
      const req = state.requests.get(e.payload.request_id);
      need(req !== undefined && req.revokedAllAt === null, "request must exist and be open");
      if (req && e.payload.contact_id !== null) need(req.contactIds.includes(e.payload.contact_id) && !req.revokedContacts.has(e.payload.contact_id), "contact must be in request, unrevoked");
      break;
    }
    case "authorization_granted":
    case "authorization_declined":
      need(state.requests.get(e.payload.request_id)?.contactIds.includes(e.payload.contact_id) === true, "authorization references a request for the contact");
      need(!state.erasedContacts.has(e.payload.contact_id), "erased contact authorizing");
      need(e.actor.type === "contact" && e.actor.id === e.payload.contact_id, "actor is the contact");
      break;
    case "item_confirmed":
    case "item_disputed": {
      const p = e.payload;
      const req = state.requests.get(p.request_id);
      need(state.authorizations.get(p.contact_id)?.decision === "granted", "contact must be authorized");
      need(!state.erasedContacts.has(p.contact_id), "erased contact responding");
      need(req !== undefined && req.contactIds.includes(p.contact_id) && contactRevokedAt(req, p.contact_id) === null, "request must include the unrevoked contact");
      need(req !== undefined && e.recordedAt.getTime() < req.expiresAt.getTime(), "request expired");
      need(req?.items.some((i) => i.itemId === p.item_id && i.version === p.version && i.contentHash === p.content_hash) === true, "request must include this item version");
      const item = activeItem(p.item_id);
      need(item !== undefined && currentVersionOf(item).version === p.version && currentVersionOf(item).contentHash === p.content_hash, "response must target the current version");
      const sameBatch = prev !== undefined && (prev.type === "item_confirmed" || prev.type === "item_disputed") && prev.payload.submission_id === p.submission_id;
      need(sameBatch || !state.submissions.has(p.submission_id), "submission id reused");
      need(e.actor.type === "contact" && e.actor.id === p.contact_id, "actor is the contact");
      break;
    }
    case "contact_erased":
      need(!state.erasedContacts.has(e.payload.contact_id), "contact erased twice");
      break;
    default:
      break;
  }
  return v;
}

describe("arbStoredLog", () => {
  it("generates only valid events (independent command-rule checker)", () => {
    fc.assert(
      fc.property(arbStoredLog(), (gen) => {
        let state = emptyState();
        let prev: StoredEvent | undefined;
        for (const e of gen.events) {
          expect(violations(state, e, prev)).toEqual([]);
          state = reduce(state, e);
          prev = e;
        }
        for (const d of gen.drafts) expect(parseEventDraft(d).payload).toEqual(d.payload);
      }),
      { numRuns: 40 },
    );
  });

  it("chains with the planned clock and verifies", () => {
    fc.assert(
      fc.property(arbStoredLog({ minOps: 5, maxOps: 20 }), (gen) => {
        expect(gen.events.map((e) => e.recordedAt)).toEqual(gen.recordedAt);
        expect(gen.events.map((e) => e.seq)).toEqual(gen.events.map((_, i) => i + 1));
        expect(verifyChain(gen.events).ok).toBe(true);
        expect(storedEventsOf(gen)).toEqual(gen.events);
        expect(new Set(gen.events.map((e) => e.orgId))).toEqual(new Set([gen.orgId]));
      }),
      { numRuns: 20 },
    );
  });

  it("covers every event type, shared milliseconds and multi-event submissions", () => {
    const samples = fc.sample(arbStoredLog(), { numRuns: 60, seed: 20261101 });
    const types = new Set(samples.flatMap((g) => g.events.map((e) => e.type)));
    expect([...types].sort()).toEqual([...EVENT_TYPES].sort());
    const tie = samples.some((g) => g.events.some((e, i) => i > 0 && e.recordedAt.getTime() === g.events[i - 1]!.recordedAt.getTime()));
    expect(tie).toBe(true);
    const batch = samples.some((g) =>
      g.events.some((e, i) => {
        const p = g.events[i - 1];
        return e.type === "item_confirmed" && p?.type === "item_confirmed" && p.payload.submission_id === e.payload.submission_id;
      }),
    );
    expect(batch).toBe(true);
    const total = samples.reduce((n, g) => n + g.events.length, 0);
    expect(total / samples.length).toBeGreaterThan(20);
  });
});

describe("clocks", () => {
  it("steppingClock steps and returns fresh Dates", () => {
    const clock = steppingClock(new Date("2026-01-01T00:00:00.000Z"), 500);
    const a = clock();
    a.setTime(0);
    expect(clock()).toEqual(new Date("2026-01-01T00:00:00.500Z"));
    expect(clock()).toEqual(new Date("2026-01-01T00:00:01.000Z"));
  });

  it("clockFrom replays then repeats the last time", () => {
    const clock = clockFrom([new Date(1), new Date(2)]);
    expect([clock(), clock(), clock()].map((d) => d.getTime())).toEqual([1, 2, 2]);
    expect(() => clockFrom([])()).toThrow();
  });

  it("chainDrafts never lets recorded_at go backwards", () => {
    const times = [new Date(2000), new Date(1000)];
    const drafts = [
      { type: "contact_erased" as const, actor: { type: "system" as const, id: null }, payload: { contact_id: "00000000-0000-4000-8000-000000000001" } },
      { type: "contact_erased" as const, actor: { type: "system" as const, id: null }, payload: { contact_id: "00000000-0000-4000-8000-000000000002" } },
    ];
    const events = chainDrafts(drafts, { orgId: "00000000-0000-4000-8000-00000000000a", engagementId: "00000000-0000-4000-8000-00000000000b", clock: clockFrom(times) });
    expect(events.map((e) => e.recordedAt.getTime())).toEqual([2000, 2000]);
  });
});
