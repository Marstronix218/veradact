/**
 * The engagement record (ARCHITECTURE §10): the scope-dispute artifact. Agreed record, every
 * confirmation and dispute with its evidence status, authorizations with theirs, the full event list
 * with hashes, the `verifyChain` result against the expected head, and every item version's content
 * hash recomputed from the log.
 */
import {
  asOf,
  itemContentHash,
  verifyChain,
  type AgreedView,
  type AuthorizationDecision,
  type ChainHead,
  type ChainVerification,
  type Kind,
  type Manual,
  type Span,
  type StoredEvent,
} from "@veradact/core";
import type { ExportContext } from "./context";
import { CHAIN_FAILURE_TEXT, formatDate, formatDateTime, isoUtc } from "./format";
import { mdBlockquote, mdCode, mdInline } from "./markdown";
import { contactLabel, contactLabelWithDomain } from "./present";
import { agreedItemsMarkdown, AI_OFF_NOTICE, notConfirmedMarkdown, yamlString } from "./spec";

/** Result of checking a response's `evidence_commitment` against its `confirmation_evidence` snapshot (§6). */
export type EvidenceStatus = "verified" | "erased" | "mismatch" | "missing";

export interface RecordResponse {
  seq: number;
  recordedAt: Date;
  type: "item_confirmed" | "item_disputed";
  shortId: string;
  version: number;
  contentHash: string;
  contactId: string;
  requestId: string;
  evidence: EvidenceStatus;
  /** Domain of the address in the evidence snapshot (D-057), null when erased or unknown. */
  emailDomain?: string | null;
  /** Dispute comment (`response_comment`): text, null when erased, undefined when not supplied. */
  comment?: string | null;
}

export interface RecordAuthorization {
  seq: number;
  recordedAt: Date;
  contactId: string;
  decision: AuthorizationDecision;
  textVersion: string;
  /** The authorization event's `evidence_commitment` checked against its snapshot (§6, D-047). */
  evidence: EvidenceStatus;
  /** Domain of the address in the evidence snapshot (D-057), null when erased or unknown. */
  emailDomain?: string | null;
}

/** Content hashes of `item_created` / `item_revised` payloads, recomputed with `itemContentHash`. */
export interface ContentHashCheck {
  /** Item versions checked (one per `item_created` / `item_revised` event). */
  checked: number;
  /** Versions whose recomputed hash differs from the stored `content_hash` (or cannot be recomputed). */
  mismatches: { seq: number; shortId: string; version: number }[];
}

export interface RecordEvent {
  seq: number;
  /** Event type as stored (an `EventType` for schema_version 1). */
  type: string;
  recordedAt: Date;
  occurredAt: Date;
  hash: string;
  prevHash: string;
}

export interface RecordExport {
  agreed: AgreedView;
  responses: RecordResponse[];
  authorizations: RecordAuthorization[];
  events: RecordEvent[];
  /** `verifyChain(full log, expectedHead)`. */
  verification: ChainVerification;
  /** Every item version's content hash recomputed from its payload. */
  contentHashes: ContentHashCheck;
  /** The head the log was checked against (`engagement_head`), or null. */
  expectedHead: ChainHead | null;
}

export interface RecordFromLogOptions {
  /** Time of the agreed view; defaults to the recorded time of the last event. */
  asOf?: Date;
  /** Evidence status of the response or authorization event at `seq` (from `confirmation_evidence`). */
  evidenceFor(seq: number, contactId: string): EvidenceStatus;
  /** Dispute comment of the event at `seq`: text, null when erased, undefined to leave out. */
  commentFor?(seq: number): string | null | undefined;
  /** Email domain in the evidence snapshot of the event at `seq`, so a dispute shows who confirmed. */
  emailDomainFor?(seq: number): string | null;
  expectedHead: ChainHead | null;
}

/**
 * Builds a `RecordExport` from the full engagement log in seq order, as read by the store (raw
 * stored values: the chain is verified over them). Pure.
 */
export function buildRecordExport(events: readonly StoredEvent[], opts: RecordFromLogOptions): RecordExport {
  const last = events[events.length - 1];
  const agreed = asOf(events, opts.asOf ?? last?.recordedAt ?? new Date(0), "agreed");
  const shortIds = new Map<string, string>();
  const responses: RecordResponse[] = [];
  const authorizations: RecordAuthorization[] = [];
  const kinds = new Map<string, Kind>();
  const contentHashes: ContentHashCheck = { checked: 0, mismatches: [] };
  for (const e of events) {
    switch (e.type) {
      case "item_created":
      case "item_revised": {
        const p = e.payload;
        if (e.type === "item_created") {
          shortIds.set(p.item_id, e.payload.short_id);
          kinds.set(p.item_id, e.payload.kind);
        }
        contentHashes.checked += 1;
        const recomputed = recomputeContentHash(e.engagementId, p, kinds.get(p.item_id));
        if (recomputed === null || recomputed !== p.content_hash) {
          contentHashes.mismatches.push({ seq: e.seq, shortId: shortIds.get(p.item_id) ?? String(p.item_id), version: p.version });
        }
        break;
      }
      case "item_confirmed":
      case "item_disputed": {
        const p = e.payload;
        const response: RecordResponse = {
          seq: e.seq,
          recordedAt: e.recordedAt,
          type: e.type,
          shortId: shortIds.get(p.item_id) ?? p.item_id,
          version: p.version,
          contentHash: p.content_hash,
          contactId: p.contact_id,
          requestId: p.request_id,
          evidence: opts.evidenceFor(e.seq, p.contact_id),
        };
        if (opts.emailDomainFor) response.emailDomain = opts.emailDomainFor(e.seq);
        if (e.type === "item_disputed" && opts.commentFor) {
          const comment = opts.commentFor(e.seq);
          if (comment !== undefined) response.comment = comment;
        }
        responses.push(response);
        break;
      }
      case "authorization_granted":
      case "authorization_declined":
        authorizations.push({
          seq: e.seq,
          recordedAt: e.recordedAt,
          contactId: e.payload.contact_id,
          decision: e.type === "authorization_granted" ? "granted" : "declined",
          textVersion: e.payload.text_version,
          evidence: opts.evidenceFor(e.seq, e.payload.contact_id),
          ...(opts.emailDomainFor ? { emailDomain: opts.emailDomainFor(e.seq) } : {}),
        });
        break;
      default:
        break;
    }
  }
  return {
    agreed,
    responses,
    authorizations,
    events: events.map((e) => ({ seq: e.seq, type: e.type, recordedAt: e.recordedAt, occurredAt: e.occurredAt, hash: e.hash, prevHash: e.prevHash })),
    verification: verifyChain(events, opts.expectedHead),
    contentHashes,
    expectedHead: opts.expectedHead,
  };
}

/**
 * `itemContentHash` over a stored payload (raw jsonb, never trusted to be well formed): null when
 * the item's kind is unknown (a revision without its `item_created`) or the payload cannot be hashed.
 */
function recomputeContentHash(
  engagementId: string,
  p: { item_id: string; version: number; statement: string; spans: readonly Span[]; manual: Manual | null },
  kind: Kind | undefined,
): string | null {
  if (kind === undefined) return null;
  try {
    return itemContentHash({ engagement_id: engagementId, item_id: p.item_id, kind, version: p.version, statement: p.statement, spans: p.spans, manual: p.manual });
  } catch {
    return null;
  }
}

/** `HALV-record-2026-11-01.md` / `.pdf`: generation date in the engagement time zone. */
export function recordFilename(ctx: ExportContext, extension: "md" | "pdf"): string {
  return `${ctx.engagement.shortCode}-record-${formatDate(ctx.generatedAt, ctx.engagement.timeZone)}.${extension}`;
}

// ---------------------------------------------------------------------------------------------
// Shared text (markdown and PDF). Backticks mark code; the PDF strips them.

export interface VerificationSummary {
  ok: boolean;
  headline: string;
  facts: [label: string, value: string][];
  paragraphs: string[];
}

export function verificationSummary(record: RecordExport): VerificationSummary {
  const v = record.verification;
  const total = record.events.length;
  const facts: [string, string][] = [
    ["Result", v.ok ? "OK" : "FAILED"],
    ["Events checked", v.ok ? `${v.checked} of ${total} (all events)` : `${v.checked} of ${total} verified before the failure`],
    ["Head seq", String(v.headSeq)],
    ["Head hash", v.headHash],
  ];
  const exp = record.expectedHead;
  facts.push(["Expected head", exp ? `seq ${exp.seq} (engagement head)` : "none supplied"]);
  if (exp) facts.push(["Expected head hash", exp.hash]);
  if (!v.ok) {
    facts.push(["Failure reason", v.reason ? `${CHAIN_FAILURE_TEXT[v.reason]} (${v.reason})` : "unknown"]);
    facts.push(["First bad seq", v.firstBadSeq !== undefined ? String(v.firstBadSeq) : "unknown"]);
  }
  facts.push([CONTENT_HASH_LABEL, contentHashText(record.contentHashes)]);
  const paragraphs = [
    "Each event's hash is SHA-256 over the event's canonical JSON content, which includes the previous event's hash. Changing, removing, inserting or reordering any event therefore changes every hash after it. This check recomputed every hash from the stored rows, starting at seq 1, and compared each with its stored value and with the link to the event before it.",
    "Each item version's content hash, the value every confirmation names, was also recomputed from the version's statement, spans and manual marker in the log and compared with the content hash stored in that event.",
  ];
  if (v.ok) {
    paragraphs.push(
      `Result: the log has not been altered since it was recorded, through seq ${v.headSeq}. The head hash fingerprints the entire history up to that event.`,
    );
  } else {
    const verified = v.headSeq > 0 ? `Events 1–${v.headSeq} verified.` : "No events verified.";
    paragraphs.push(
      `Result: verification FAILED at seq ${v.firstBadSeq ?? "?"}. ${verified} Entries from seq ${v.firstBadSeq ?? "?"} onward are not as originally recorded, or events are missing, and must not be relied on.`,
    );
  }
  paragraphs.push(
    "The log head (seq and hash) is also printed in the confirmation receipts emailed to the client after each submission, and in earlier exports. A receipt showing seq N and hash H must match event N in the event list of this record; a history rewritten after the receipt was sent would not.",
    "The check shows that the recorded history has not been changed. It does not show that the recorded statements are true.",
  );
  return { ok: v.ok, headline: v.ok ? "Hash-chain verification: OK" : "Hash-chain verification: FAILED", facts, paragraphs };
}

export const CONTENT_HASH_LABEL = "Item content hashes";

/** `12 of 12 verified` or `11 of 12 verified; 1 MISMATCH (HALV-R1 v2 at seq 14)`. */
export function contentHashText(check: ContentHashCheck): string {
  const ok = check.checked - check.mismatches.length;
  if (check.mismatches.length === 0) return `${ok} of ${check.checked} verified`;
  const list = check.mismatches.map((m) => `${m.shortId} v${m.version} at seq ${m.seq}`).join(", ");
  return `${ok} of ${check.checked} verified; ${check.mismatches.length} MISMATCH (${list})`;
}

export const EVIDENCE_LABEL: Readonly<Record<EvidenceStatus, string>> = {
  verified: "verified",
  erased: "erased",
  mismatch: "MISMATCH",
  missing: "missing",
};

export const EVIDENCE_LEGEND =
  "Evidence: verified = the identity snapshot taken when the contact responded matches the commitment in the log; erased = the contact was erased, so the snapshot no longer exists; MISMATCH = the snapshot does not match the commitment; missing = no snapshot was found.";

export const RESPONSE_LABEL: Readonly<Record<RecordResponse["type"], string>> = {
  item_confirmed: "confirmed",
  item_disputed: "disputed",
};

export const APPENDIX_INTRO =
  "Anyone with the engagement's raw event rows (the `event` table, ordered by `seq`) can check this record without Veradact's software:";

export const APPENDIX_STEPS: readonly string[] = [
  'For each event, build this object from the stored row: `{"v":1, "org_id", "engagement_id", "seq", "type", "schema_version", "payload", "actor": {"type", "id"}, "occurred_at", "recorded_at", "prev_hash"}`. `seq` and `schema_version` are JSON numbers; `payload` is the stored JSON as is; timestamps are ISO 8601 strings in UTC with milliseconds, exactly as `Date.prototype.toISOString()` prints them (for example `2026-03-02T15:00:00.000Z`).',
  "Serialize it as canonical JSON: object keys sorted recursively by UTF-16 code unit order (plain byte order for these ASCII keys), no whitespace, arrays in their stored order, strings escaped as `JSON.stringify` escapes them, integers only.",
  "The event's hash is the lowercase hex SHA-256 of the UTF-8 bytes of that string. It must equal the stored `hash`; `prev_hash` must equal the previous event's `hash` (64 zeros for seq 1); `seq` must run 1, 2, 3, … without gaps.",
  "An item version's content hash is the SHA-256 of the canonical JSON of `{engagement_id, item_id, kind, version, statement, spans, manual}` (each span as `{source_id, source_sha256, start, end}`). It is the content hash shown for each item, and every confirmation names the content hash it confirmed.",
  "Compare the hash of event N with the head hash printed for seq N in any confirmation receipt or earlier export.",
];

export const APPENDIX_CODE: readonly string[] = [
  'const { createHash } = require("node:crypto");',
  "const canon = (v) => Array.isArray(v) ? `[${v.map(canon).join(\",\")}]`",
  '  : v !== null && typeof v === "object"',
  '    ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`',
  "    : JSON.stringify(v);",
  "const eventHash = (row) => createHash(\"sha256\").update(canon({",
  "  v: 1, org_id: row.org_id, engagement_id: row.engagement_id, seq: Number(row.seq), type: row.type,",
  "  schema_version: Number(row.schema_version), payload: row.payload,",
  "  actor: { type: row.actor_type, id: row.actor_id },",
  "  occurred_at: new Date(row.occurred_at).toISOString(),",
  "  recorded_at: new Date(row.recorded_at).toISOString(),",
  "  prev_hash: row.prev_hash,",
  '}), "utf8").digest("hex");',
];

// ---------------------------------------------------------------------------------------------
// Markdown

function cell(text: string): string {
  return mdInline(text) || " ";
}

export function renderRecordMarkdown(record: RecordExport, ctx: ExportContext): string {
  const e = ctx.engagement;
  const tz = e.timeZone;
  const view = record.agreed;
  const summary = verificationSummary(record);
  const out: string[] = [
    "---",
    "veradact_export: record",
    "format_version: 1",
    `engagement: ${yamlString(e.shortCode)}`,
    `generated_at: ${yamlString(isoUtc(ctx.generatedAt))}`,
    `agreed_as_of: ${yamlString(isoUtc(view.asOf))}`,
    `log_head_seq: ${ctx.head.seq}`,
    `log_head_hash: ${yamlString(ctx.head.hash)}`,
    `chain_verified: ${summary.ok}`,
    `content_hashes_verified: ${record.contentHashes.mismatches.length === 0}`,
    "---",
    "",
    `# Engagement record: ${mdInline(e.name)}`,
    "",
    `- **Engagement:** ${mdInline(e.name)} (${mdCode(e.shortCode)})`,
    `- **Client:** ${mdInline(e.clientName)}`,
    `- **Vendor:** ${mdInline(ctx.vendorName)}`,
    `- **Generated:** ${formatDateTime(ctx.generatedAt, tz)} (${mdCode(isoUtc(ctx.generatedAt))})`,
    `- **Time zone:** ${mdCode(tz)}`,
    `- **Agreed record as of:** ${formatDateTime(view.asOf, tz)} (${mdCode(isoUtc(view.asOf))}), log through seq ${view.head.seq}`,
    `- **Log head at export:** seq ${ctx.head.seq} · ${mdCode(ctx.head.hash)}`,
    `- **Events in this record:** ${record.events.length}`,
    "",
    "This record is generated from the engagement's append-only, hash-chained event log. Times in tables are UTC, exactly as recorded and hashed.",
    "",
    "## Hash-chain verification",
    "",
    `**${summary.headline}**`,
    "",
    ...summary.facts.map(([label, value]) => `- **${label}:** ${/^[0-9a-f]{64}$/.test(value) ? mdCode(value) : mdInline(value)}`),
    "",
    ...summary.paragraphs.flatMap((p) => [p, ""]),
    "## Agreed record",
    "",
    `Items whose current version was confirmed as of ${formatDateTime(view.asOf, tz)}, shown at the confirmed version.`,
    "",
  ];
  if (!e.aiEnabled) out.push(`> ${AI_OFF_NOTICE}`, "");
  out.push(...agreedItemsMarkdown(view, ctx, 3));
  out.push("### Not confirmed", "", ...notConfirmedMarkdown(view.notConfirmed));
  if (view.previouslyAgreed.length > 0) {
    out.push("### Previously agreed versions (revision pending)", "");
    for (const p of view.previouslyAgreed) {
      const by = p.confirmations.map((c) => `${contactLabel(c.contactId, c.contactErased, ctx)} (${formatDate(c.recordedAt, tz)})`);
      out.push(
        `- ${mdInline(p.shortId)} · ${mdInline(p.agreedStatement)} — agreed at version ${p.agreedVersion} (${mdCode(p.agreedContentHash)}) by ${mdInline(by.join(", ") || "none recorded")}; current version ${p.currentVersion} is ${p.currentStatus}.`,
      );
    }
    out.push("");
  }

  out.push("## Confirmations and disputes", "");
  if (record.responses.length === 0) out.push("No responses recorded.", "");
  else {
    out.push(
      "| Seq | Recorded at (UTC) | Contact | Response | Item | Version | Content hash | Request id | Evidence |",
      "|---:|---|---|---|---|---:|---|---|---|",
    );
    for (const r of record.responses) {
      out.push(
        `| ${r.seq} | ${isoUtc(r.recordedAt)} | ${cell(contactLabelWithDomain(r.contactId, r.evidence === "erased", r.emailDomain, ctx))} | ${RESPONSE_LABEL[r.type]} | ${cell(r.shortId)} | ${r.version} | ${mdCode(r.contentHash)} | ${mdCode(r.requestId)} | ${EVIDENCE_LABEL[r.evidence]} |`,
      );
    }
    out.push("", EVIDENCE_LEGEND, "");
    const comments = record.responses.filter((r) => r.type === "item_disputed" && r.comment !== undefined);
    if (comments.length > 0) {
      out.push("**Dispute comments**", "");
      for (const r of comments) {
        out.push(`- Seq ${r.seq} · ${mdInline(r.shortId)} version ${r.version} · ${mdInline(contactLabelWithDomain(r.contactId, r.evidence === "erased", r.emailDomain, ctx))}:`);
        out.push(r.comment ? mdBlockquote(r.comment, "  ") : "  (comment erased)");
      }
      out.push("");
    }
  }

  out.push("## Authorizations", "");
  if (record.authorizations.length === 0) out.push("No authorizations recorded.", "");
  else {
    out.push("| Seq | Recorded at (UTC) | Contact | Decision | Text version | Evidence |", "|---:|---|---|---|---|---|");
    for (const a of record.authorizations) {
      out.push(
        `| ${a.seq} | ${isoUtc(a.recordedAt)} | ${cell(contactLabelWithDomain(a.contactId, a.evidence === "erased", a.emailDomain, ctx))} | ${a.decision} | ${cell(a.textVersion)} | ${EVIDENCE_LABEL[a.evidence]} |`,
      );
    }
    out.push("", EVIDENCE_LEGEND, "");
  }

  const badSeq = record.verification.ok ? undefined : record.verification.firstBadSeq;
  out.push(
    "## Event log",
    "",
    `${record.events.length} events. Each hash covers the event's content and the previous event's hash (\`prev_hash\`; 64 zeros for seq 1).`,
    "",
    "| Seq | Type | Recorded at (UTC) | Occurred at (UTC) | Hash |",
    "|---:|---|---|---|---|",
  );
  for (const ev of record.events) {
    const seq = ev.seq === badSeq ? `**${ev.seq} (first bad)**` : String(ev.seq);
    out.push(`| ${seq} | ${mdCode(ev.type)} | ${isoUtc(ev.recordedAt)} | ${isoUtc(ev.occurredAt)} | ${mdCode(ev.hash)} |`);
  }
  out.push(
    "",
    "## Appendix: recomputing the hashes",
    "",
    APPENDIX_INTRO,
    "",
    ...APPENDIX_STEPS.map((s, i) => `${i + 1}. ${s}`),
    "",
    "In Node.js:",
    "",
    "```js",
    ...APPENDIX_CODE,
    "```",
  );
  return `${out.join("\n").trimEnd()}\n`;
}
