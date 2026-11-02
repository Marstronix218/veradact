// POST /api/cron/reminders — sends due confirmation reminders (ARCHITECTURE §8.6). Called by the
// platform scheduler with `Authorization: Bearer ${CRON_SECRET}` (constant-time compare).
import type { NextRequest } from "next/server";
import { logError, runReminders } from "@veradact/core";
import { clock } from "@/lib/clock";
import { cronJson, isCronAuthorized } from "@/lib/cron";
import { getDb } from "@/lib/db";
import { getEmailProvider } from "@/lib/email";
import { appUrl } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  if (!isCronAuthorized(request.headers.get("authorization"))) return cronJson({ error: "unauthorized" }, 401);
  try {
    const result = await runReminders({ db: getDb(), now: clock(), emailProvider: getEmailProvider(), appUrl: appUrl() });
    return cronJson({ ok: true, ...result });
  } catch (error) {
    logError("cron.reminders_failed", error);
    return cronJson({ error: "failed" }, 500);
  }
}
