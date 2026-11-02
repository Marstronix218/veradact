// GET /api/engagements/[id]/export/spec.md?as_of= — the confirmed spec as markdown (ARCHITECTURE
// §10). Session required; usage + audit `export.spec`. `as_of` is `YYYY-MM-DD` (end of that day in
// the engagement time zone) or an ISO timestamp with an offset; omitted = the current log.
import type { NextRequest } from "next/server";
import { clock } from "@/lib/clock";
import { getDb } from "@/lib/db";
import { exportDownload } from "@/lib/export-download";
import { getAuth } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return exportDownload({ db: getDb(), auth: await getAuth(), engagementRef: id, kind: "spec", asOf: request.nextUrl.searchParams.get("as_of"), clock });
}
