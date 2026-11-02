// GET /api/metrics.csv — org and per-engagement metrics as CSV (ARCHITECTURE §12). Session
// required; RLS scopes the data to the signed-in user's org.
import { buildMetricsCsv } from "@veradact/core";
import { withTenant } from "@veradact/db";
import { clock } from "@/lib/clock";
import { getDb } from "@/lib/db";
import { getAuth } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const auth = await getAuth();
  if (!auth) return new Response("Sign in to download metrics.\n", { status: 401, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  const csv = await withTenant(getDb(), { orgId: auth.orgId, userId: auth.userId }, (tx) => buildMetricsCsv(tx, clock()));
  return new Response(csv.body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csv.filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
