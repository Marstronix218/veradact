// Builds the `ExportContext` the pure renderers need from the projection and side tables, inside
// the caller's tenant transaction (see `../context.ts` for the rules each field follows).
import { eq } from "drizzle-orm";
import { appUser, clientContact, contactPii, engagement, org, source, sourceContent, ZERO_HASH, type Tx } from "@veradact/db";
import { NotFoundError, readEngagementHead, sha256Hex, UUID_PATTERN, type Span } from "@veradact/core";
import type { ExportContext, ExportSource } from "../context";

export interface LoadExportContextInput {
  engagementId: string;
  clock: () => Date;
  /** The requested as-of time, or null/omitted for the current log. */
  asOf?: Date | null;
}

/** `org.ai_enabled && engagement.ai_enabled` (D-027: AI-off outputs for agents carry no quotes). */
export async function effectiveAiEnabled(tx: Tx, e: { orgId: string; aiEnabled: boolean }): Promise<boolean> {
  if (!e.aiEnabled) return false;
  const [row] = await tx.select({ aiEnabled: org.aiEnabled }).from(org).where(eq(org.id, e.orgId));
  return row?.aiEnabled === true;
}

/**
 * Org name, engagement, effective AI flag, `engagement_head`, every source of the engagement (title
 * and text only when AI is on), `quoteFor` with the `source_sha256` check, contact names (null when
 * erased) and user names. Reads the clock once (`generatedAt`). Throws `NotFoundError` for an
 * engagement that is unknown in this tenant.
 */
export async function loadExportContext(tx: Tx, input: LoadExportContextInput): Promise<ExportContext> {
  const { engagementId } = input;
  if (!UUID_PATTERN.test(engagementId)) throw new NotFoundError();
  const [row] = await tx
    .select({ engagement, vendorName: org.name, orgAiEnabled: org.aiEnabled })
    .from(engagement)
    .innerJoin(org, eq(org.id, engagement.orgId))
    .where(eq(engagement.id, engagementId));
  if (!row) throw new NotFoundError();
  const e = row.engagement;
  const aiEnabled = row.orgAiEnabled && e.aiEnabled;

  const sourceColumns = { id: source.id, sourceType: source.sourceType, occurredAt: source.occurredAt, redactedAt: source.redactedAt };
  const [head, sourceRows, contacts, users] = await Promise.all([
    readEngagementHead(tx, engagementId),
    // AI off: titles and text are never read (D-027, D-044).
    aiEnabled
      ? tx
          .select({ ...sourceColumns, title: sourceContent.title, text: sourceContent.text })
          .from(source)
          .leftJoin(sourceContent, eq(sourceContent.sourceId, source.id))
          .where(eq(source.engagementId, engagementId))
      : tx
          .select(sourceColumns)
          .from(source)
          .where(eq(source.engagementId, engagementId))
          .then((rows) => rows.map((r) => ({ ...r, title: null, text: null }))),
    tx
      .select({ id: clientContact.id, erasedAt: clientContact.erasedAt, name: contactPii.name })
      .from(clientContact)
      .leftJoin(contactPii, eq(contactPii.contactId, clientContact.id))
      .where(eq(clientContact.engagementId, engagementId)),
    tx.select({ id: appUser.id, name: appUser.name }).from(appUser),
  ]);

  const sources: Record<string, ExportSource> = {};
  const texts = new Map<string, { text: string; sha256: string | null }>();
  for (const s of sourceRows) {
    sources[s.id] = { sourceType: s.sourceType, occurredAt: s.occurredAt, title: s.redactedAt === null ? s.title : null, redactedAt: s.redactedAt };
    if (s.text !== null && s.redactedAt === null) texts.set(s.id, { text: s.text, sha256: null });
  }
  const contactNames = new Map(contacts.map((c) => [c.id, c.erasedAt === null ? c.name : null]));
  const userNames = new Map(users.map((u) => [u.id, u.name]));

  return {
    engagement: { name: e.name, clientName: e.clientName, shortCode: e.shortCode, timeZone: e.timeZone, aiEnabled },
    vendorName: row.vendorName,
    generatedAt: input.clock(),
    asOf: input.asOf ?? null,
    head: head ? { seq: head.seq, hash: head.hash } : { seq: 0, hash: ZERO_HASH },
    sources,
    quoteFor(span: Span): string | null {
      const content = texts.get(span.source_id);
      if (!content) return null;
      content.sha256 ??= sha256Hex(content.text);
      if (content.sha256 !== span.source_sha256) return null;
      if (span.start < 0 || span.end > content.text.length || span.start > span.end) return null;
      return content.text.slice(span.start, span.end);
    },
    contactName: (contactId) => contactNames.get(contactId) ?? null,
    userName: (userId) => userNames.get(userId) ?? null,
  };
}
