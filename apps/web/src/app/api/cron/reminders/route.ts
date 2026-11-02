// POST /api/cron/reminders — sends due confirmation reminders (ARCHITECTURE §8.6). Called by the
// platform scheduler with `Authorization: Bearer ${CRON_SECRET}` (constant-time compare).
import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { logError, runReminders } from "@veradact/core";
import { clock } from "@/lib/clock";
import { getDb } from "@/lib/db";
import { getEmailProvider } from "@/lib/email";
import { appUrl } from "@/lib/env";

export const dynamic = "force-dynamic";

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/** Compares sha256 digests so the comparison is constant time whatever the lengths. */
function authorized(header: string | null): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || !header?.startsWith("Bearer ")) return false;
  return timingSafeEqual(digest(header.slice("Bearer ".length).trim()), digest(secret));
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function POST(request: NextRequest): Promise<Response> {
  if (!authorized(request.headers.get("authorization"))) return json({ error: "unauthorized" }, 401);
  try {
    const result = await runReminders({ db: getDb(), now: clock(), emailProvider: getEmailProvider(), appUrl: appUrl() });
    return json({ ok: true, ...result });
  } catch (error) {
    logError("cron.reminders_failed", error);
    return json({ error: "failed" }, 500);
  }
}
