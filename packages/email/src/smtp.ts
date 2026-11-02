import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import type { SendMailOptions } from "nodemailer";
import { assertSingleRecipient, deliveryCodeOf, EmailDeliveryError } from "./errors";
import type { EmailMessage, EmailProvider } from "./types";

export interface SmtpEmailProviderOptions {
  /** `smtp://` or `smtps://` URL, credentials included. Never logged or put in errors. */
  url: string;
  /** Envelope and header sender, e.g. `Veradact <no-reply@example.com>`. */
  from: string;
  /** Replaces the nodemailer transport (tests). */
  transport?: { sendMail(options: SendMailOptions): Promise<{ messageId?: string }> };
}

/** Delivers through any SMTP server (Mailpit in dev, a provider's relay in production). */
export class SmtpEmailProvider implements EmailProvider {
  readonly name = "smtp";
  readonly #from: string;
  readonly #transport: NonNullable<SmtpEmailProviderOptions["transport"]>;

  constructor(options: SmtpEmailProviderOptions) {
    this.#from = options.from;
    this.#transport =
      options.transport ??
      nodemailer.createTransport({
        url: options.url,
        // Fail in seconds, not nodemailer's default minutes, so a request is not held open.
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
      });
  }

  async send(msg: EmailMessage): Promise<{ id: string }> {
    assertSingleRecipient(msg);
    try {
      const info = await this.#transport.sendMail({
        from: this.#from,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        ...(msg.html !== undefined ? { html: msg.html } : {}),
      });
      return { id: info.messageId ?? `smtp-${randomUUID()}` };
    } catch (err) {
      // Deliberately no `cause`: nodemailer messages and responses quote the recipient.
      throw new EmailDeliveryError(deliveryCodeOf(err));
    }
  }
}
