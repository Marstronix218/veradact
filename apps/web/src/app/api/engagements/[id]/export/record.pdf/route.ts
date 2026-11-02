// GET /api/engagements/[id]/export/record.pdf — the engagement record as PDF (pdfkit, listed in
// `serverExternalPackages`). Session required; usage + audit `export.record_pdf`.
import { clock } from "@/lib/clock";
import { getDb } from "@/lib/db";
import { exportDownload } from "@/lib/export-download";
import { getAuth } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return exportDownload({ db: getDb(), auth: await getAuth(), engagementRef: id, kind: "record_pdf", clock });
}
