import { randomUUID } from "node:crypto";
import { assertSingleRecipient } from "./errors";
import type { EmailMessage, EmailProvider } from "./types";

export interface ConsoleEmailProviderOptions {
  /** Permit construction when NODE_ENV is "production". Default false. */
  allowInProduction?: boolean;
  /** Where output goes. Default: process.stdout. */
  write?: (chunk: string) => void;
  /** Defaults to process.env.NODE_ENV. */
  nodeEnv?: string | undefined;
}

const RULE = "-".repeat(72);

/**
 * Prints the complete message (recipient, body, links) to stdout so a developer can click
 * through flows locally. This is the one place email content is deliberately written out,
 * which is why it refuses to exist in production.
 */
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = "console";
  readonly #write: (chunk: string) => void;

  constructor(options: ConsoleEmailProviderOptions = {}) {
    const nodeEnv = "nodeEnv" in options ? options.nodeEnv : process.env.NODE_ENV;
    if (nodeEnv === "production" && !options.allowInProduction) {
      throw new Error(
        "ConsoleEmailProvider prints message bodies and recipients and cannot be used when " +
          "NODE_ENV=production. Configure EMAIL_PROVIDER=smtp.",
      );
    }
    this.#write = options.write ?? ((chunk) => void process.stdout.write(chunk));
  }

  async send(msg: EmailMessage): Promise<{ id: string }> {
    assertSingleRecipient(msg);
    const id = `console-${randomUUID()}`;
    const lines = [
      RULE,
      `[email:console] id=${id}`,
      `To:      ${msg.to}`,
      `Subject: ${msg.subject}`,
    ];
    if (msg.tags && Object.keys(msg.tags).length > 0) {
      lines.push(
        `Tags:    ${Object.entries(msg.tags)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")}`,
      );
    }
    lines.push("", msg.text);
    if (msg.html !== undefined) lines.push("", "--- html part ---", msg.html);
    lines.push(RULE, "");
    this.#write(lines.join("\n"));
    return { id };
  }
}
