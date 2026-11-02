import { randomUUID } from "node:crypto";
import { assertSingleRecipient } from "./errors";
import type { EmailMessage, EmailProvider } from "./types";

export type SentEmail = EmailMessage & { readonly id: string };

/** Keeps every sent message in process memory. For unit and integration tests only. */
export class MemoryEmailProvider implements EmailProvider {
  readonly name = "memory";
  readonly #sent: SentEmail[] = [];

  /** Snapshot of everything sent, oldest first. */
  get messages(): readonly SentEmail[] {
    return [...this.#sent];
  }

  async send(msg: EmailMessage): Promise<{ id: string }> {
    assertSingleRecipient(msg);
    const id = `memory-${randomUUID()}`;
    this.#sent.push({ ...structuredClone(msg), id });
    return { id };
  }

  /** Most recent message sent to `address` (case-insensitive), or undefined. */
  lastTo(address: string): SentEmail | undefined {
    const wanted = address.toLowerCase();
    for (let i = this.#sent.length - 1; i >= 0; i--) {
      const m = this.#sent[i];
      if (m && m.to.toLowerCase() === wanted) return m;
    }
    return undefined;
  }

  clear(): void {
    this.#sent.length = 0;
  }
}
