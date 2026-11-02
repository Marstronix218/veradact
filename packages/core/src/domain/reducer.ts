/**
 * The only projection logic (ARCHITECTURE §5.1, CLAUDE.md invariant 2).
 *
 * `reduce` is pure, deterministic and total for well-formed events: references to unknown items,
 * sources or requests are ignored rather than thrown on (commands reject invalid transitions before
 * anything is appended). It never mutates its input state; changed collections are copied.
 *
 * Every event whose payload names an existing item (`item_id`) updates that item's `updatedAt` and
 * `lastSeq`, as does a needs-review flag raised on a dependent.
 */
import type { StoredEvent, StoredEventOf } from "./events";
import {
  deriveStatus,
  emptyState,
  type EngagementState,
  type ItemResponse,
  type ItemState,
  type ReviewCause,
} from "./state";

type Items = Map<string, ItemState>;

function touched(item: ItemState, event: StoredEvent): ItemState {
  return { ...item, updatedAt: event.recordedAt, lastSeq: event.seq };
}

/** D-011: flag every active direct dependent of `upstreamId`. Mutates only the copied map. */
function flagDependents(items: Items, upstreamId: string, cause: ReviewCause, event: StoredEvent): void {
  for (const [id, item] of items) {
    if (id === upstreamId || item.lifecycle !== "active" || !item.dependsOn.has(upstreamId)) continue;
    items.set(id, {
      ...touched(item, event),
      needsReview: true,
      reviewReasons: [...item.reviewReasons, { upstreamItemId: upstreamId, cause, seq: event.seq }],
    });
  }
}

/** Copies `items`, applies `update` to the named item (if it exists) and returns the new state. */
function updateItem(
  state: EngagementState,
  itemId: string,
  event: StoredEvent,
  update: (item: ItemState, items: Items) => ItemState,
): EngagementState {
  const item = state.items.get(itemId);
  if (!item) return state;
  const items: Items = new Map(state.items);
  items.set(itemId, update(touched(item, event), items));
  return { ...state, items };
}

function applyItemCreated(state: EngagementState, e: StoredEventOf<"item_created">): EngagementState {
  const p = e.payload;
  if (state.items.has(p.item_id)) return state;
  const dependsOn = new Map<string, number>();
  for (const dep of p.depends_on) if (dep !== p.item_id && !dependsOn.has(dep)) dependsOn.set(dep, e.seq);
  const base: Omit<ItemState, "status"> = {
    id: p.item_id,
    shortId: p.short_id,
    kind: p.kind,
    versions: [
      {
        version: p.version,
        contentHash: p.content_hash,
        previousContentHash: null,
        statement: p.statement,
        spans: p.spans,
        manual: p.manual,
        provenance: p.provenance,
        reasonCode: null,
        occurredAt: e.occurredAt,
        recordedAt: e.recordedAt,
        seq: e.seq,
      },
    ],
    currentVersion: p.version,
    lifecycle: "active",
    supersededBy: null,
    dependsOn,
    needsReview: false,
    reviewReasons: [],
    responses: [],
    createdAt: e.recordedAt,
    updatedAt: e.recordedAt,
    lastSeq: e.seq,
  };
  const items: Items = new Map(state.items);
  items.set(p.item_id, { ...base, status: deriveStatus(base) });
  return { ...state, items, kindCounters: { ...state.kindCounters, [p.kind]: state.kindCounters[p.kind] + 1 } };
}

function applyItemRevised(state: EngagementState, e: StoredEventOf<"item_revised">): EngagementState {
  const p = e.payload;
  return updateItem(state, p.item_id, e, (item, items) => {
    const revised: Omit<ItemState, "status"> = {
      ...item,
      versions: [
        ...item.versions,
        {
          version: p.version,
          contentHash: p.content_hash,
          previousContentHash: p.previous_content_hash,
          statement: p.statement,
          spans: p.spans,
          manual: p.manual,
          provenance: p.provenance,
          reasonCode: p.reason_code,
          occurredAt: e.occurredAt,
          recordedAt: e.recordedAt,
          seq: e.seq,
        },
      ],
      currentVersion: p.version,
      needsReview: false,
      reviewReasons: [],
    };
    flagDependents(items, p.item_id, "revised", e);
    return { ...revised, status: deriveStatus(revised) };
  });
}

function applyResponse(
  state: EngagementState,
  e: StoredEventOf<"item_confirmed"> | StoredEventOf<"item_disputed">,
): EngagementState {
  const p = e.payload;
  const submissions = new Set(state.submissions);
  submissions.add(p.submission_id);
  const response: ItemResponse = {
    seq: e.seq,
    version: p.version,
    contentHash: p.content_hash,
    contactId: p.contact_id,
    requestId: p.request_id,
    submissionId: p.submission_id,
    response: e.type === "item_confirmed" ? "confirmed" : "disputed",
    channel: p.channel,
    evidenceCommitment: p.evidence_commitment,
    commentCommitment: e.type === "item_disputed" ? e.payload.comment_commitment : null,
    recordedAt: e.recordedAt,
  };
  const next = updateItem(state, p.item_id, e, (item, items) => {
    const withResponse = { ...item, responses: [...item.responses, response] };
    const current = item.versions.find((v) => v.version === item.currentVersion);
    if (
      response.response === "disputed" &&
      current !== undefined &&
      current.version === p.version &&
      current.contentHash === p.content_hash
    ) {
      flagDependents(items, p.item_id, "disputed", e);
    }
    return { ...withResponse, status: deriveStatus(withResponse) };
  });
  return { ...next, submissions };
}

function apply(state: EngagementState, e: StoredEvent): EngagementState {
  switch (e.type) {
    case "engagement_created": {
      const p = e.payload;
      return {
        ...state,
        engagement: {
          id: p.engagement_id,
          orgId: e.orgId,
          shortCode: p.short_code,
          name: p.name,
          clientName: p.client_name,
          timeZone: p.time_zone,
        },
      };
    }
    case "engagement_updated": {
      if (!state.engagement) return state;
      const p = e.payload;
      return {
        ...state,
        engagement: {
          ...state.engagement,
          ...(p.name !== undefined ? { name: p.name } : {}),
          ...(p.client_name !== undefined ? { clientName: p.client_name } : {}),
          ...(p.time_zone !== undefined ? { timeZone: p.time_zone } : {}),
        },
      };
    }
    case "source_ingested": {
      const p = e.payload;
      if (state.sources.has(p.source_id)) return state;
      const sources = new Map(state.sources);
      sources.set(p.source_id, {
        id: p.source_id,
        sourceType: p.source_type,
        format: p.format,
        occurredAt: e.occurredAt,
        recordedAt: e.recordedAt,
        contentSha256: p.content_sha256,
        charLength: p.char_length,
        participantCount: p.participant_count,
        attestation: p.attestation,
        ingestedBy: e.actor.id ?? p.attestation.attested_by,
        seq: e.seq,
        redacted: null,
      });
      return { ...state, sources };
    }
    case "source_redacted": {
      const p = e.payload;
      const source = state.sources.get(p.source_id);
      if (!source || source.redacted) return state;
      const sources = new Map(state.sources);
      sources.set(p.source_id, { ...source, redacted: { at: e.recordedAt, reasonCode: p.reason_code, seq: e.seq } });
      return { ...state, sources };
    }
    case "item_created":
      return applyItemCreated(state, e);
    case "item_revised":
      return applyItemRevised(state, e);
    case "item_superseded": {
      const p = e.payload;
      return updateItem(state, p.item_id, e, (item, items) => {
        flagDependents(items, p.item_id, "superseded", e);
        return { ...item, lifecycle: "superseded", supersededBy: p.superseded_by_item_id };
      });
    }
    case "item_withdrawn": {
      const p = e.payload;
      return updateItem(state, p.item_id, e, (item, items) => {
        flagDependents(items, p.item_id, "withdrawn", e);
        return { ...item, lifecycle: "withdrawn" };
      });
    }
    case "dependency_added": {
      const p = e.payload;
      return updateItem(state, p.item_id, e, (item) => {
        if (p.depends_on_item_id === p.item_id || item.dependsOn.has(p.depends_on_item_id)) return item;
        const dependsOn = new Map(item.dependsOn);
        dependsOn.set(p.depends_on_item_id, e.seq);
        return { ...item, dependsOn };
      });
    }
    case "dependency_removed": {
      const p = e.payload;
      return updateItem(state, p.item_id, e, (item) => {
        if (!item.dependsOn.has(p.depends_on_item_id)) return item;
        const dependsOn = new Map(item.dependsOn);
        dependsOn.delete(p.depends_on_item_id);
        return { ...item, dependsOn };
      });
    }
    case "review_cleared":
      return updateItem(state, e.payload.item_id, e, (item) => ({ ...item, needsReview: false, reviewReasons: [] }));
    case "confirmation_requested": {
      const p = e.payload;
      if (state.requests.has(p.request_id)) return state;
      const requests = new Map(state.requests);
      requests.set(p.request_id, {
        id: p.request_id,
        items: p.items.map((i) => ({ itemId: i.item_id, version: i.version, contentHash: i.content_hash })),
        contactIds: [...p.contact_ids],
        revokedContacts: new Map(),
        revokedAllAt: null,
        expiresAt: new Date(p.expires_at),
        channel: p.channel,
        requestedBy: e.actor.id,
        recordedAt: e.recordedAt,
        seq: e.seq,
      });
      return { ...state, requests };
    }
    case "confirmation_revoked": {
      const p = e.payload;
      const request = state.requests.get(p.request_id);
      if (!request) return state;
      let updated = request;
      if (p.contact_id === null) {
        if (request.revokedAllAt === null) updated = { ...request, revokedAllAt: e.recordedAt };
      } else if (request.contactIds.includes(p.contact_id) && !request.revokedContacts.has(p.contact_id)) {
        const revokedContacts = new Map(request.revokedContacts);
        revokedContacts.set(p.contact_id, e.recordedAt);
        updated = { ...request, revokedContacts };
      }
      if (updated === request) return state;
      const requests = new Map(state.requests);
      requests.set(p.request_id, updated);
      return { ...state, requests };
    }
    case "authorization_granted":
    case "authorization_declined": {
      const p = e.payload;
      const authorizations = new Map(state.authorizations);
      authorizations.set(p.contact_id, {
        contactId: p.contact_id,
        decision: e.type === "authorization_granted" ? "granted" : "declined",
        requestId: p.request_id,
        textVersion: p.text_version,
        textSha256: p.text_sha256,
        at: e.recordedAt,
        seq: e.seq,
      });
      return { ...state, authorizations };
    }
    case "item_confirmed":
    case "item_disputed":
      return applyResponse(state, e);
    case "contact_erased": {
      if (state.erasedContacts.has(e.payload.contact_id)) return state;
      const erasedContacts = new Set(state.erasedContacts);
      erasedContacts.add(e.payload.contact_id);
      return { ...state, erasedContacts };
    }
    default:
      return state;
  }
}

export function reduce(state: EngagementState, event: StoredEvent): EngagementState {
  return { ...apply(state, event), headSeq: event.seq, headHash: event.hash, headRecordedAt: event.recordedAt };
}

export function fold(events: Iterable<StoredEvent>, initial: EngagementState = emptyState()): EngagementState {
  let state = initial;
  for (const event of events) state = reduce(state, event);
  return state;
}
