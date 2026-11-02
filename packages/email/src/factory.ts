import { ConsoleEmailProvider } from "./console";
import { MemoryEmailProvider } from "./memory";
import { SmtpEmailProvider } from "./smtp";
import type { EmailProvider } from "./types";

type Env = Record<string, string | undefined>;

/**
 * Builds the provider named by `EMAIL_PROVIDER` (`console` | `smtp` | `memory`).
 *
 * - Unset defaults to `console` outside production and is an error in production.
 * - `console` and `memory` are refused in production (see `ConsoleEmailProvider`).
 * - `smtp` needs `SMTP_URL` and `EMAIL_FROM`.
 * Errors name the variable, never its value: SMTP_URL carries credentials.
 */
export function createEmailProviderFromEnv(env: Env = process.env): EmailProvider {
  const production = env.NODE_ENV === "production";
  const kind = env.EMAIL_PROVIDER?.trim().toLowerCase() || (production ? undefined : "console");

  switch (kind) {
    case "console":
      return new ConsoleEmailProvider({ nodeEnv: env.NODE_ENV });
    case "memory":
      if (production) {
        throw new Error("EMAIL_PROVIDER=memory discards mail and cannot be used in production.");
      }
      return new MemoryEmailProvider();
    case "smtp": {
      const url = env.SMTP_URL?.trim();
      const from = env.EMAIL_FROM?.trim();
      if (!url) throw new Error("EMAIL_PROVIDER=smtp requires SMTP_URL.");
      if (!from) throw new Error("EMAIL_PROVIDER=smtp requires EMAIL_FROM.");
      if (!/^smtps?:\/\//i.test(url)) {
        throw new Error("SMTP_URL must start with smtp:// or smtps://.");
      }
      return new SmtpEmailProvider({ url, from });
    }
    case undefined:
      throw new Error("EMAIL_PROVIDER is required in production (smtp).");
    default:
      throw new Error("EMAIL_PROVIDER must be one of: console, smtp, memory.");
  }
}
