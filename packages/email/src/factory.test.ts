import { describe, expect, it } from "vitest";
import { ConsoleEmailProvider } from "./console";
import { createEmailProviderFromEnv } from "./factory";
import { MemoryEmailProvider } from "./memory";
import { SmtpEmailProvider } from "./smtp";

describe("createEmailProviderFromEnv", () => {
  it("builds each provider by name", () => {
    expect(createEmailProviderFromEnv({ EMAIL_PROVIDER: "memory" })).toBeInstanceOf(MemoryEmailProvider);
    expect(createEmailProviderFromEnv({ EMAIL_PROVIDER: "console" })).toBeInstanceOf(ConsoleEmailProvider);
    const smtp = createEmailProviderFromEnv({
      EMAIL_PROVIDER: "smtp",
      SMTP_URL: "smtp://localhost:54331",
      EMAIL_FROM: "Veradact <no-reply@veradact.local>",
    });
    expect(smtp).toBeInstanceOf(SmtpEmailProvider);
    expect(smtp.name).toBe("smtp");
  });

  it("is case- and whitespace-tolerant", () => {
    expect(createEmailProviderFromEnv({ EMAIL_PROVIDER: " Memory " })).toBeInstanceOf(MemoryEmailProvider);
  });

  it("defaults to console outside production", () => {
    expect(createEmailProviderFromEnv({})).toBeInstanceOf(ConsoleEmailProvider);
    expect(createEmailProviderFromEnv({ EMAIL_PROVIDER: "", NODE_ENV: "development" })).toBeInstanceOf(
      ConsoleEmailProvider,
    );
  });

  it("requires an explicit provider in production", () => {
    expect(() => createEmailProviderFromEnv({ NODE_ENV: "production" })).toThrow(/EMAIL_PROVIDER is required/);
  });

  it("refuses console and memory in production", () => {
    expect(() => createEmailProviderFromEnv({ NODE_ENV: "production", EMAIL_PROVIDER: "console" })).toThrow(
      /production/,
    );
    expect(() => createEmailProviderFromEnv({ NODE_ENV: "production", EMAIL_PROVIDER: "memory" })).toThrow(
      /production/,
    );
  });

  it("allows smtp in production", () => {
    const env = {
      NODE_ENV: "production",
      EMAIL_PROVIDER: "smtp",
      SMTP_URL: "smtps://user:pw@smtp.example.test:465",
      EMAIL_FROM: "no-reply@example.test",
    };
    expect(createEmailProviderFromEnv(env)).toBeInstanceOf(SmtpEmailProvider);
  });

  it("requires SMTP_URL and EMAIL_FROM for smtp, naming the variable", () => {
    expect(() => createEmailProviderFromEnv({ EMAIL_PROVIDER: "smtp", EMAIL_FROM: "a@b.test" })).toThrow(/SMTP_URL/);
    expect(() => createEmailProviderFromEnv({ EMAIL_PROVIDER: "smtp", SMTP_URL: "smtp://h:25" })).toThrow(
      /EMAIL_FROM/,
    );
  });

  it("never echoes configuration values in errors (SMTP_URL carries credentials)", () => {
    const secretUrl = "mailto://user:hunter2@smtp.example.test";
    let message = "";
    try {
      createEmailProviderFromEnv({ EMAIL_PROVIDER: "smtp", SMTP_URL: secretUrl, EMAIL_FROM: "a@b.test" });
    } catch (err) {
      message = String(err);
    }
    expect(message).toMatch(/SMTP_URL/);
    expect(message).not.toContain("hunter2");

    expect(() => createEmailProviderFromEnv({ EMAIL_PROVIDER: "smtp://user:hunter2@host" })).toThrow(
      /must be one of/,
    );
    try {
      createEmailProviderFromEnv({ EMAIL_PROVIDER: "smtp://user:hunter2@host" });
    } catch (err) {
      expect(String(err)).not.toContain("hunter2");
    }
  });

  it("rejects an unknown provider", () => {
    expect(() => createEmailProviderFromEnv({ EMAIL_PROVIDER: "sendgrid" })).toThrow(/console, smtp, memory/);
  });

  it("reads process.env by default", () => {
    const previous = process.env.EMAIL_PROVIDER;
    process.env.EMAIL_PROVIDER = "memory";
    try {
      expect(createEmailProviderFromEnv()).toBeInstanceOf(MemoryEmailProvider);
    } finally {
      if (previous === undefined) delete process.env.EMAIL_PROVIDER;
      else process.env.EMAIL_PROVIDER = previous;
    }
  });
});
