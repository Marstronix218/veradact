// Client contacts (ARCHITECTURE §2.1, §6). `client_contact` holds no PII; name, email, title and
// the per-contact HMAC key live in the erasable `contact_pii`. No events: contacts enter the log
// only by id (requests, authorizations, responses, erasure).
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { clientContact, contactPii, engagement, type Tx } from "@veradact/db";
import { writeAudit } from "../audit";
import { normalizeEmail } from "../auth/email-address";
import { DomainError } from "../errors";
import { logId } from "../log";
import { runInTenant, type CommandContext } from "./context";
import { emailInDomains } from "./engagements";

const NAME_MAX = 200;
export const CONTACT_HMAC_KEY_BYTES = 32;

function cleanText(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > max) throw new DomainError("invalid_name");
  return trimmed;
}

function cleanTitle(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value.trim() === "") return null;
  return cleanText(value, NAME_MAX);
}

function cleanEmail(value: string): string {
  const email = normalizeEmail(value);
  if (!email) throw new DomainError("invalid_email");
  return email;
}

export interface AddContactInput {
  engagementId: string;
  /** Defaults to a random UUID. */
  contactId?: string;
  name: string;
  email: string;
  title?: string | null;
  /**
   * The member confirms that an address outside the engagement's client email domains speaks for
   * the client (D-057). Required in that case; audited as `contact.outside_domains`.
   */
  acknowledgeOutsideDomains?: boolean;
}

/**
 * Self-confirmation guard (D-057): with client email domains set, an address outside them needs
 * the member's acknowledgement, which is audited (ids only).
 */
async function checkClientDomains(tx: Tx, ctx: CommandContext, input: { engagementId: string; contactId: string; acknowledgeOutsideDomains?: boolean }, email: string, domains: readonly string[]): Promise<void> {
  if (domains.length === 0 || emailInDomains(email, domains)) return;
  if (input.acknowledgeOutsideDomains !== true) throw new DomainError("contact_outside_client_domains");
  await writeAudit(tx, {
    orgId: ctx.orgId,
    actorUserId: ctx.userId,
    action: "contact.outside_domains",
    targetType: "contact",
    targetId: input.contactId,
    metadata: { engagement_id: logId(input.engagementId), client_email_domains_count: domains.length },
    at: ctx.clock(),
  });
}

/** Creates `client_contact` + `contact_pii` with a fresh random 32-byte HMAC key. */
export async function addContact(ctx: CommandContext, input: AddContactInput): Promise<{ contactId: string }> {
  const name = cleanText(input.name, NAME_MAX);
  const email = cleanEmail(input.email);
  const title = cleanTitle(input.title);
  const contactId = input.contactId ?? randomUUID();
  return runInTenant(ctx, async (tx) => {
    const [found] = await tx.select({ id: engagement.id, domains: engagement.clientEmailDomains }).from(engagement).where(eq(engagement.id, input.engagementId));
    if (!found) throw new DomainError("engagement_not_found");
    await tx.insert(clientContact).values({ id: contactId, orgId: ctx.orgId, engagementId: input.engagementId, createdAt: ctx.clock() });
    await checkClientDomains(tx, ctx, { ...input, contactId }, email, found.domains);
    await tx.insert(contactPii).values({
      contactId,
      orgId: ctx.orgId,
      name,
      email,
      title,
      hmacKey: randomBytes(CONTACT_HMAC_KEY_BYTES),
    });
    return { contactId };
  });
}

export interface UpdateContactInput {
  engagementId: string;
  contactId: string;
  name?: string;
  email?: string;
  /** null or "" clears the title. */
  title?: string | null;
  /** As for `addContact`, when the new email is outside the client email domains. */
  acknowledgeOutsideDomains?: boolean;
}

/** Updates PII only (the HMAC key never changes). Erased contacts cannot be updated. */
export async function updateContact(ctx: CommandContext, input: UpdateContactInput): Promise<void> {
  const patch: { name?: string; email?: string; title?: string | null } = {};
  if (input.name !== undefined) patch.name = cleanText(input.name, NAME_MAX);
  if (input.email !== undefined) patch.email = cleanEmail(input.email);
  if (input.title !== undefined) patch.title = cleanTitle(input.title);
  if (Object.keys(patch).length === 0) throw new DomainError("nothing_to_update");
  await runInTenant(ctx, async (tx) => {
    await requireLiveContact(tx, input.engagementId, input.contactId);
    if (patch.email !== undefined) {
      const [row] = await tx.select({ domains: engagement.clientEmailDomains }).from(engagement).where(eq(engagement.id, input.engagementId));
      await checkClientDomains(tx, ctx, input, patch.email, row?.domains ?? []);
    }
    await tx.update(contactPii).set(patch).where(eq(contactPii.contactId, input.contactId));
  });
}

export interface LiveContact {
  contactId: string;
  name: string;
  email: string;
  hmacKey: Buffer;
}

/**
 * The contact with its PII, or `contact_not_found` (not in this engagement) / `contact_erased`
 * (erased, or PII already deleted).
 */
export async function requireLiveContact(tx: Tx, engagementId: string, contactId: string): Promise<LiveContact> {
  const [row] = await tx
    .select({
      contactId: clientContact.id,
      erasedAt: clientContact.erasedAt,
      name: contactPii.name,
      email: contactPii.email,
      hmacKey: contactPii.hmacKey,
    })
    .from(clientContact)
    .leftJoin(contactPii, eq(contactPii.contactId, clientContact.id))
    .where(and(eq(clientContact.id, contactId), eq(clientContact.engagementId, engagementId)));
  if (!row) throw new DomainError("contact_not_found", { contactId });
  if (row.erasedAt !== null || row.name === null || row.email === null || row.hmacKey === null) {
    throw new DomainError("contact_erased", { contactId });
  }
  return { contactId: row.contactId, name: row.name, email: row.email, hmacKey: row.hmacKey };
}
