/**
 * Test-only scenario for the export tests: a realistic HALV log built with the core `LogBuilder`,
 * and an `ExportContext` resolved from it the way the web app and MCP server do from queries.
 * Synthetic data and fictional companies only.
 */
import { fold, sha256Hex, type Span, type StoredEvent } from "@veradact/core";
import { LogBuilder, TEST_ATTESTATION, type SpanRef } from "@veradact/core/testing";
import type { ExportContext } from "./context";

export const T0 = "2026-03-02T15:00:00.000Z";
export const T1 = "2026-03-03T15:00:00.000Z";
export const T2 = "2026-03-05T15:00:00.000Z";
export const T3 = "2026-03-06T15:00:00.000Z";
export const GENERATED_AT = new Date("2026-11-01T14:00:00.000Z");

export const SOURCE_TEXT: Record<string, string> = {
  kickoff: [
    "Kickoff call, Halvorsen Freight.",
    "Ingrid: Invoicing by hand takes two days every month.",
    "Ingrid: Invoices must be exported as CSV every night (see <invoice-spec> & #42).",
    "# Not a heading",
    "- not a list",
    "Tomas: We'll push a nightly batch to S3.",
  ].join("\n"),
  email: [
    "From the client's IT lead:",
    "All customer data must stay in the EU.",
    "The CSV needs a header row with *exact* column names.",
    "Keep the column order of the old export.",
    "Carrier portal access is out of scope for now.",
  ].join("\n"),
  "old-notes": "Workshop notes: carriers send proof of delivery by email.",
};

export const SOURCE_TITLE: Record<string, string> = {
  kickoff: "Kickoff call",
  email: "IT lead email",
  "old-notes": "Old workshop notes",
};

/** A span covering `quote` in the named source text. */
export function spanOf(source: string, quote: string): SpanRef {
  const start = SOURCE_TEXT[source]!.indexOf(quote);
  if (start < 0) throw new Error(`quote not in ${source}`);
  return { source, start, end: start + quote.length };
}

export const QUOTES = {
  p1: "Invoicing by hand takes two days every month.",
  c1: "All customer data must stay in the EU.",
  a1: "carriers send proof of delivery by email.",
  d1: "We'll push a nightly batch to S3.",
  r1: "Invoices must be exported as CSV every night (see <invoice-spec> & #42).\n# Not a heading\n- not a list",
  r1b: "The CSV needs a header row with *exact* column names.",
  r2: "Keep the column order of the old export.",
  r3: "Carrier portal access is out of scope for now.",
} as const;

export const STATEMENTS = {
  p1: "Manual invoicing takes two days each month",
  c1: "Customer data stays in the EU",
  a1: "Carriers send proof of delivery by email",
  c2: "Phase one budget is fixed",
  d1v1: "Nightly batch export to S3",
  d1v2: "Hourly batch export to S3 in eu-west-1",
  r1: "Export invoices as CSV every night",
  r2: "CSV column order matches the old export",
  r3: "Carrier portal integration",
  r4: "Weekly summary email to finance",
  r5: "Fax confirmations",
} as const;

export const NAMES = { alice: "Alice Example", bob: "Bob Builder", member: "Morgan Member" } as const;

function emailSource(b: LogBuilder, occurredAt: string): void {
  b.push({
    type: "source_ingested",
    actor: { type: "user", id: b.userId },
    occurredAt: new Date(occurredAt),
    payload: {
      source_id: b.id("source:email"),
      source_type: "email",
      format: "paste",
      content_sha256: sha256Hex("text of email"),
      char_length: SOURCE_TEXT.email!.length,
      participant_count: 2,
      attestation: { ...TEST_ATTESTATION(b.userId), source_type: "email" },
    },
  });
}

/**
 * HALV at T3: P1, C1, A1 (source redacted), C2 (manual, confirmed by an erased contact) and R1
 * (needs review: D1 revised) are agreed; D1 is revision-pending; R2 pending, R3 disputed, R4 never
 * requested; R5 withdrawn.
 */
export function halvLog(): LogBuilder {
  const b = new LogBuilder({ start: new Date(T0) })
    .engagement()
    .source("kickoff", { occurredAt: "2026-03-01T14:00:00.000Z", charLength: SOURCE_TEXT.kickoff!.length })
    .source("old-notes", { occurredAt: "2026-02-20T15:00:00.000Z", charLength: SOURCE_TEXT["old-notes"]!.length });
  emailSource(b, "2026-02-27T20:00:00.000Z");
  b.create("p1", "problem", STATEMENTS.p1, { spans: [spanOf("kickoff", QUOTES.p1)] })
    .create("c1", "constraint", STATEMENTS.c1, { spans: [spanOf("email", QUOTES.c1)] })
    .create("a1", "assumption", STATEMENTS.a1, { spans: [spanOf("old-notes", QUOTES.a1)] })
    .create("c2", "constraint", STATEMENTS.c2)
    .create("d1", "decision", STATEMENTS.d1v1, { spans: [spanOf("kickoff", QUOTES.d1)] })
    .create("r1", "requirement", STATEMENTS.r1, { spans: [spanOf("kickoff", QUOTES.r1), spanOf("email", QUOTES.r1b)], dependsOn: ["d1"] })
    .create("r2", "requirement", STATEMENTS.r2, { spans: [spanOf("email", QUOTES.r2)] })
    .create("r3", "requirement", STATEMENTS.r3, { spans: [spanOf("email", QUOTES.r3)] })
    .create("r4", "requirement", STATEMENTS.r4)
    .create("r5", "requirement", STATEMENTS.r5);
  b.at(T1)
    .request("q1", ["p1", "c1", "a1", "c2", "d1", "r1", "r2", "r3"], ["alice", "bob"])
    .authorize("alice", "q1")
    .authorize("bob", "q1")
    .confirm("p1", "alice", "q1", { submission: "a" })
    .confirm("c1", "alice", "q1", { submission: "a" })
    .confirm("a1", "alice", "q1", { submission: "a" })
    .confirm("d1", "alice", "q1", { submission: "a" })
    .confirm("r1", "alice", "q1", { submission: "a" })
    .confirm("c2", "bob", "q1", { submission: "b" })
    .dispute("r3", "bob", "q1", { submission: "b" });
  b.at(T2).revise("d1", STATEMENTS.d1v2).redact("old-notes");
  b.at(T3).eraseContact("bob").withdraw("r5");
  return b;
}

export interface ContextOptions {
  aiEnabled?: boolean;
  asOf?: Date | null;
  /** Called for every quote lookup (to assert it is never called when AI is off). */
  onQuote?: (span: Span) => void;
}

/** Resolves an `ExportContext` from the log, as callers do from the projection and side tables. */
export function contextFor(b: LogBuilder, events: readonly StoredEvent[] = b.log, opts: ContextOptions = {}): ExportContext {
  const state = fold(events);
  const sourceNames = new Map(Object.keys(SOURCE_TEXT).map((name) => [b.id(`source:${name}`), name]));
  const sources: ExportContext["sources"] = Object.fromEntries(
    [...state.sources.values()].map((s) => [
      s.id,
      {
        sourceType: s.sourceType,
        occurredAt: s.occurredAt,
        title: s.redacted ? null : (SOURCE_TITLE[sourceNames.get(s.id) ?? ""] ?? null),
        redactedAt: s.redacted?.at ?? null,
      },
    ]),
  );
  const contacts = new Map<string, string>([
    [b.id("contact:alice"), NAMES.alice],
    [b.id("contact:bob"), NAMES.bob],
  ]);
  return {
    engagement: {
      name: state.engagement!.name,
      clientName: state.engagement!.clientName,
      shortCode: state.engagement!.shortCode,
      timeZone: state.engagement!.timeZone,
      aiEnabled: opts.aiEnabled ?? true,
    },
    vendorName: "Quillfield Labs",
    generatedAt: GENERATED_AT,
    asOf: opts.asOf ?? null,
    head: { seq: state.headSeq, hash: state.headHash },
    sources,
    quoteFor(span) {
      opts.onQuote?.(span);
      const name = sourceNames.get(span.source_id);
      if (!name || state.sources.get(span.source_id)?.redacted) return null;
      return SOURCE_TEXT[name]!.slice(span.start, span.end);
    },
    contactName: (id) => (state.erasedContacts.has(id) ? null : (contacts.get(id) ?? null)),
    userName: (id) => (id === b.userId ? NAMES.member : null),
  };
}

/** Text drawn by `[...] TJ` operators in an uncompressed pdfkit PDF, one line per operator. */
export function pdfTextContent(pdf: Buffer): string {
  const raw = pdf.toString("latin1");
  const lines: string[] = [];
  for (const m of raw.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
    let line = "";
    for (const h of m[1]!.matchAll(/<([0-9a-fA-F]*)>/g)) line += Buffer.from(h[1]!, "hex").toString("latin1");
    lines.push(line);
  }
  return lines.join("\n");
}
