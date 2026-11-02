import { createEmailProviderFromEnv, type EmailProvider } from "@veradact/email";

const globalForEmail = globalThis as typeof globalThis & { __veradactEmail?: EmailProvider };

/** The provider named by EMAIL_PROVIDER (smtp → Mailpit in dev), created once per process. */
export function getEmailProvider(): EmailProvider {
  globalForEmail.__veradactEmail ??= createEmailProviderFromEnv();
  return globalForEmail.__veradactEmail;
}
