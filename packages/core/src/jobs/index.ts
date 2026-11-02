// Scheduled jobs (ARCHITECTURE §8.6, §6 retention). Triggered by `pnpm jobs:run` or the
// `/api/cron/*` routes (bearer CRON_SECRET).
import type { Db } from "@veradact/db";
import type { EmailProvider } from "@veradact/email";
import { runReminders, type RunRemindersResult } from "./reminders";

export { runReminders, type RunRemindersInput, type RunRemindersResult } from "./reminders";

export interface ScheduledJobsInput {
  db: Db;
  now: Date;
  emailProvider: EmailProvider;
  appUrl: string;
}

export interface ScheduledJobsResult {
  reminders: RunRemindersResult;
}

/**
 * Runs every scheduled job once. Retention (redacting sources older than `org.retention_days`,
 * ARCHITECTURE §6) is added here in Phase 5, next to reminders.
 */
export async function runScheduledJobs(input: ScheduledJobsInput): Promise<ScheduledJobsResult> {
  const reminders = await runReminders(input);
  return { reminders };
}
