import { clearRateLimits, closeAdminDb } from "./helpers/db";

/** Repeated local runs share one client IP; start each run with fresh rate-limit windows. */
export default async function globalSetup(): Promise<void> {
  try {
    await clearRateLimits();
  } finally {
    await closeAdminDb();
  }
}
