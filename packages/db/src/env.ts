import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rootEnvPath = fileURLToPath(new URL("../../../.env", import.meta.url));

/** Loads the repo-root `.env` if present. Never overrides variables already set. */
export function loadRootEnv(): void {
  if (existsSync(rootEnvPath)) process.loadEnvFile(rootEnvPath);
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
}
