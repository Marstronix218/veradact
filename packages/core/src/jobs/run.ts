// `pnpm jobs:run` — runs every scheduled job once (reminders, then retention) and
// exits. Uses the app role (DATABASE_URL); never the admin URL. Loads the repo-root .env outside
// production; variables already set win.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDb } from "@veradact/db";
import { createEmailProviderFromEnv } from "@veradact/email";
import { logError } from "../log";
import { assertProductionSecrets } from "../security/secrets";
import { runScheduledJobs } from "./index";

const rootEnv = fileURLToPath(new URL("../../../../.env", import.meta.url));
if (process.env.NODE_ENV !== "production" && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
}

assertProductionSecrets();
const handle = createDb(required("DATABASE_URL"), { max: 2 });
try {
  const result = await runScheduledJobs({
    db: handle.db,
    now: new Date(),
    emailProvider: createEmailProviderFromEnv(),
    appUrl: required("APP_URL"),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  logError("jobs.run_failed", error);
  process.exitCode = 1;
} finally {
  await handle.close();
}
