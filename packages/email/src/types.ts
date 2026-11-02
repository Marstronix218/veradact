export interface EmailMessage {
  /** One recipient address. Display names and address lists are rejected. */
  to: string;
  subject: string;
  text: string;
  html?: string;
  /**
   * Free-form labels for the provider or for test assertions (ids and enums, never PII).
   * The memory and console providers record them; SMTP has no tag concept and ignores them.
   */
  tags?: Record<string, string>;
}

export interface EmailProvider {
  readonly name: string;
  send(msg: EmailMessage): Promise<{ id: string }>;
}
