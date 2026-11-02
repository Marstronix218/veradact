import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createEmailProviderFromEnv } from "./factory";
import { extractFirstLink, isMailpitReachable, mailpitLatestTo } from "./mailpit";
import { SmtpEmailProvider } from "./smtp";

// Mailpit from `pnpm db:up`: SMTP :54331, web/API :54332 (defaults match the root .env).
const SMTP_URL = process.env.SMTP_URL ?? "smtp://localhost:54331";
const FROM = process.env.EMAIL_FROM ?? "Veradact <no-reply@veradact.local>";
const BASE_URL = process.env.MAILPIT_URL ?? "http://localhost:54332";

const reachable = await isMailpitReachable({ baseUrl: BASE_URL });
if (!reachable) {
  console.warn(
    `[email int] Mailpit is not reachable at ${BASE_URL}; skipping SMTP integration tests. ` +
      "Start it with `pnpm db:up`.",
  );
}

// Every test uses its own random recipient, so nothing here clears the shared mailbox and
// the suite can run next to other tests that also send mail.
const uniqueAddress = (label: string) => `${label}-${randomUUID()}@example.test`;

const suiteName = reachable
  ? `SmtpEmailProvider -> Mailpit (${BASE_URL})`
  : `SmtpEmailProvider -> Mailpit [skipped: Mailpit unreachable at ${BASE_URL}, run pnpm db:up]`;

describe.skipIf(!reachable)(suiteName, () => {
  it("delivers a message that the Mailpit helper reads back", async () => {
    const to = uniqueAddress("confirm");
    const link = `http://localhost:3000/c/v1.${randomUUID()}.1790000000.sig`;
    const mail = new SmtpEmailProvider({ url: SMTP_URL, from: FROM });

    const { id } = await mail.send({
      to,
      subject: "Please confirm 3 items",
      text: `Review and confirm here:\n${link}\n\nThis link expires in 14 days.`,
      html: `<p><a href="${link}">Review</a></p>`,
    });
    expect(id).toBeTruthy();

    const received = await mailpitLatestTo(to, { baseUrl: BASE_URL, timeoutMs: 10_000 });
    expect(received.subject).toBe("Please confirm 3 items");
    expect(received.text).toContain("Review and confirm here:");
    expect(received.html).toContain(link);
    expect(extractFirstLink(received.text, "/c/")).toBe(link);
  });

  it("returns the newest of several messages to the same address", async () => {
    const to = uniqueAddress("magic");
    const mail = createEmailProviderFromEnv({ EMAIL_PROVIDER: "smtp", SMTP_URL, EMAIL_FROM: FROM });

    // Mailpit stores a message before it acknowledges the SMTP DATA, so both exist after send().
    await mail.send({ to, subject: "first", text: "http://localhost:3000/auth/verify?token=one" });
    await mail.send({ to, subject: "second", text: "Sign in: http://localhost:3000/auth/verify?token=two" });

    const latest = await mailpitLatestTo(to, { baseUrl: BASE_URL });
    expect(latest.subject).toBe("second");
    expect(extractFirstLink(latest.text, "/auth/verify")).toBe("http://localhost:3000/auth/verify?token=two");
  });

  it("leaves other recipients' mail alone", async () => {
    const to = uniqueAddress("only");
    await new SmtpEmailProvider({ url: SMTP_URL, from: FROM }).send({ to, subject: "mine", text: "x" });
    await expect(
      mailpitLatestTo(uniqueAddress("nobody"), { baseUrl: BASE_URL, timeoutMs: 300, pollIntervalMs: 50 }),
    ).rejects.toThrow(/No matching message/);
  });

  it("rethrows an unreachable SMTP server as EmailDeliveryError with a code only", async () => {
    const to = uniqueAddress("nowhere");
    const err = await new SmtpEmailProvider({ url: "smtp://127.0.0.1:1", from: FROM })
      .send({ to, subject: "s", text: "t" })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "EmailDeliveryError", code: expect.stringMatching(/^E[A-Z]+$/) });
    expect(String(err)).not.toContain(to);
  });
});
