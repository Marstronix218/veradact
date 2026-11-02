// Scheduled jobs (ARCHITECTURE §8.6, §6 retention). Triggered by `pnpm jobs:run` or the
// `/api/cron/*` routes (bearer CRON_SECRET).
import type { Db } from "@veradact/db";
import type { EmailProvider } from "@veradact/email";
import { runReminders, type RunRemindersResult } from "./reminders";
import { runRetention, type RunRetentionResult } from "./retention";

export { runReminders, type RunRemindersInput, type RunRemindersResult } from "./reminders";
export { runRetention, RATE_LIMIT_BUCKET_MAX_AGE_MS, type RunRetentionInput, type RunRetentionResult } from "./retention";

export interface ScheduledJobsInput {
  db: Db;
  now: Date;
  emailProvider: EmailProvider;
  appUrl: string;
}

export interface ScheduledJobsResult {
  reminders: RunRemindersResult;
  retention: RunRetentionResult;
}

/** Runs every scheduled job once: reminders (§8.6), then retention (§6). */
export async function runScheduledJobs(input: ScheduledJobsInput): Promise<ScheduledJobsResult> {
  const reminders = await runReminders(input);
  const retention = await runRetention({ db: input.db, now: input.now });
  return { reminders, retention };
}
