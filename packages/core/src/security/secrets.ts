// Production secret checks (ARCHITECTURE §14). `.env.example` ships dev placeholders
// ("dev-only-change-me-…"); a production process that still carries one, or a secret too short to
// resist guessing, refuses to start. Errors name the variable, never its value.

/** Secrets read from the environment. `LINK_SIGNING_SECRET` is required; the others when set. */
export const PRODUCTION_SECRETS = ["SESSION_SECRET", "LINK_SIGNING_SECRET", "CRON_SECRET"] as const;
const REQUIRED: ReadonlySet<string> = new Set(["LINK_SIGNING_SECRET"]);
const MIN_LENGTH = 32;
const PLACEHOLDER = /^dev-only|change-?me/i;

/** True for a value that is too short or looks like a placeholder (`dev-only-…`, `…change-me…`). */
export function isWeakSecret(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length < MIN_LENGTH || PLACEHOLDER.test(trimmed);
}

/** The secrets that are missing, too short or still a placeholder (empty outside production). */
export function unsafeProductionSecrets(env: Record<string, string | undefined> = process.env): string[] {
  if (env.NODE_ENV !== "production") return [];
  return PRODUCTION_SECRETS.filter((name) => {
    const value = env[name]?.trim() ?? "";
    if (value === "") return REQUIRED.has(name);
    return isWeakSecret(value);
  });
}

/** Throws in production when any secret is unsafe (see `unsafeProductionSecrets`). */
export function assertProductionSecrets(env: Record<string, string | undefined> = process.env): void {
  const unsafe = unsafeProductionSecrets(env);
  if (unsafe.length > 0) {
    throw new Error(
      `Refusing to start in production: ${unsafe.join(", ")} must be set to at least ${MIN_LENGTH} random characters, not a placeholder (generate with: openssl rand -base64 32)`,
    );
  }
}
