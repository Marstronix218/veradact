// Data retention (ARCHITECTURE §6): for every org with `retention_days` set, sources whose
// `recorded_at` is older than the window are redacted through the real `redactSource` command
// (reason `retention`, system actor), which deletes their text and candidates and appends
// `source_redacted`. Item versions keep their spans and hashes, so the chain still verifies.
// Expired rate-limit windows are pruned in the same run. Idempotent: redacted sources are skipped.
// Jobs list org ids through the definer function and do all work per org inside withTenant (§7).
import { and, asc, eq, isNull, lt } from "drizzle-orm";
import { jobsListOrgIds, org, source, withTenant, type Db } from "@veradact/db";
import { redactSource } from "../commands";
import { isDomainError } from "../errors";
import { logError, logId } from "../log";
import { pruneRateLimitBuckets } from "../security/rate-limit";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rate-limit windows older than this are deleted. Must exceed the longest window in use (15 min). */
export const RATE_LIMIT_BUCKET_MAX_AGE_MS = DAY_MS;

export interface RunRetentionInput {
  db: Db;
  now: Date;
  /** Limits source redaction to these orgs (tests share one database). Default: every org. */
  onlyOrgIds?: readonly string[];
  /**
   * Also delete rate-limit windows older than `RATE_LIMIT_BUCKET_MAX_AGE_MS` (a global table, not
   * per org). Default true; tests that share the database with rate-limit tests turn it off.
   */
  pruneRateLimits?: boolean;
}

export interface RunRetentionResult {
  /** Orgs with a retention window that were checked. */
  orgs: number;
  /** Sources redacted by this run. */
  redacted: number;
  /** Sources that could not be redacted (logged; retried on the next run). */
  failed: number;
  rateLimitBucketsPruned: number;
}

export async function runRetention(input: RunRetentionInput): Promise<RunRetentionResult> {
  const { db, now } = input;
  const clock = () => new Date(now.getTime());
  const result: RunRetentionResult = { orgs: 0, redacted: 0, failed: 0, rateLimitBucketsPruned: 0 };

  const orgIds = (await jobsListOrgIds(db)).filter((id) => !input.onlyOrgIds || input.onlyOrgIds.includes(id));
  for (const orgId of orgIds) {
    const due = await withTenant(db, { orgId }, async (tx) => {
      const [settings] = await tx.select({ days: org.retentionDays }).from(org).where(eq(org.id, orgId));
      if (!settings || settings.days === null) return null;
      const cutoff = new Date(now.getTime() - settings.days * DAY_MS);
      return tx
        .select({ sourceId: source.id, engagementId: source.engagementId })
        .from(source)
        .where(and(isNull(source.redactedAt), lt(source.recordedAt, cutoff)))
        .orderBy(asc(source.recordedAt), asc(source.id));
    });
    if (due === null) continue;
    result.orgs++;

    // One transaction per source, so one failure does not hold back the others.
    for (const { sourceId, engagementId } of due) {
      try {
        await redactSource({ db, orgId, userId: null, clock }, { engagementId, sourceId, reasonCode: "retention" });
        result.redacted++;
      } catch (error) {
        // Redacted by a member since the list was read: nothing left to do.
        if (isDomainError(error, "source_redacted")) continue;
        result.failed++;
        logError("jobs.retention.redact_failed", error, { orgId: logId(orgId), sourceId: logId(sourceId) });
      }
    }
  }

  if (input.pruneRateLimits ?? true) {
    result.rateLimitBucketsPruned = await pruneRateLimitBuckets(db, new Date(now.getTime() - RATE_LIMIT_BUCKET_MAX_AGE_MS));
  }
  return result;
}
