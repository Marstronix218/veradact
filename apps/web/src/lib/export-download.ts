// Spec and record downloads (ARCHITECTURE §10, §14) behind the route handlers in
// `app/api/engagements/[id]/export/*`. Kept free of Next request APIs so the handlers stay thin and
// this module can be tested against the test database.
import { ValidationError, writeAudit, type AuditAction } from "@veradact/core";
import { withTenant, type Db, type UsageEventKind } from "@veradact/db";
import { recordFilename, renderRecordMarkdown, renderRecordPdf } from "@veradact/export";
import { loadRecord, loadSpec, parseAsOf, recordUsage, resolveEngagementRef } from "@veradact/export/server";

export type ExportDownloadKind = "spec" | "record_md" | "record_pdf";

const KINDS: Record<ExportDownloadKind, { usage: UsageEventKind; audit: AuditAction }> = {
  spec: { usage: "spec_export", audit: "export.spec" },
  record_md: { usage: "record_export_md", audit: "export.record_md" },
  record_pdf: { usage: "record_export_pdf", audit: "export.record_pdf" },
};

export interface ExportDownloadInput {
  db: Db;
  /** The signed-in user, or null (→ 401). */
  auth: { orgId: string; userId: string } | null;
  /** The `[id]` route segment: engagement UUID or short code. */
  engagementRef: string;
  kind: ExportDownloadKind;
  /** Raw `as_of` query parameter (spec only): `YYYY-MM-DD` (end of that day, engagement time zone) or an ISO timestamp with offset. */
  asOf?: string | null;
  clock: () => Date;
}

function text(status: number, body: string): Response {
  return new Response(`${body}\n`, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

function attachment(body: string | Uint8Array, contentType: string, filename: string): Response {
  return new Response(body as BodyInit, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Renders the requested export in the user's tenant transaction and writes one `usage_event` and
 * one `audit_log` row with it (both roll back if rendering fails). Another org's engagement is
 * invisible under RLS and answers 404 like an unknown one.
 */
export async function exportDownload(input: ExportDownloadInput): Promise<Response> {
  const { auth, kind } = input;
  if (!auth) return text(401, "Sign in to download exports.");
  const meta = KINDS[kind];
  return withTenant(input.db, { orgId: auth.orgId, userId: auth.userId }, async (tx) => {
    const engagement = await resolveEngagementRef(tx, input.engagementRef);
    if (!engagement) return text(404, "Not found.");

    let response: Response;
    let metadata: Record<string, number | boolean>;
    let at: Date;
    if (kind === "spec") {
      let asOf: Date | null = null;
      const raw = input.asOf?.trim() ?? "";
      if (raw !== "") {
        try {
          asOf = parseAsOf(raw, engagement.timeZone);
        } catch (error) {
          if (error instanceof ValidationError) return text(400, error.message);
          throw error;
        }
      }
      const spec = await loadSpec(tx, { engagementId: engagement.id, asOf, clock: input.clock });
      at = spec.ctx.generatedAt;
      metadata = { as_of: asOf !== null, head_seq: spec.view.head.seq, item_count: spec.view.items.length };
      response = attachment(spec.markdown, "text/markdown; charset=utf-8", spec.filename);
    } else {
      const { record, ctx } = await loadRecord(tx, { engagementId: engagement.id, clock: input.clock });
      at = ctx.generatedAt;
      metadata = { head_seq: ctx.head.seq, chain_ok: record.verification.ok, event_count: record.events.length };
      response =
        kind === "record_md"
          ? attachment(renderRecordMarkdown(record, ctx), "text/markdown; charset=utf-8", recordFilename(ctx, "md"))
          : attachment(new Uint8Array(await renderRecordPdf(record, ctx)), "application/pdf", recordFilename(ctx, "pdf"));
    }

    // Same transaction as the reads: a failed render leaves no usage or audit row.
    await recordUsage(tx, { orgId: auth.orgId, engagementId: engagement.id, kind: meta.usage, userId: auth.userId, at });
    await writeAudit(tx, { orgId: auth.orgId, actorUserId: auth.userId, action: meta.audit, targetType: "engagement", targetId: engagement.id, metadata, at });
    return response;
  });
}
