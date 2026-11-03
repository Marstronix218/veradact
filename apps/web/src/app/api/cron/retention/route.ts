// POST or GET /api/cron/retention — redacts sources older than each org's retention window and
// prunes expired rate-limit windows (ARCHITECTURE §6). Called daily by the platform scheduler with
// `Authorization: Bearer ${CRON_SECRET}` (constant-time compare); Vercel Cron sends GET (D-065).
import type { NextRequest } from "next/server";
import { logError, runRetention } from "@veradact/core";
import { clock } from "@/lib/clock";
import { cronJson, isCronAuthorized } from "@/lib/cron";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  if (!isCronAuthorized(request.headers.get("authorization"))) return cronJson({ error: "unauthorized" }, 401);
  try {
    const result = await runRetention({ db: getDb(), now: clock() });
    return cronJson({ ok: true, ...result });
  } catch (error) {
    logError("cron.retention_failed", error);
    return cronJson({ error: "failed" }, 500);
  }
}

export const GET = POST;
