// Client contacts (ARCHITECTURE §2.1, §6). `client_contact` holds no PII; name, email, title and
// the per-contact HMAC key live in the erasable `contact_pii`. No events: contacts enter the log
// only by id (requests, authorizations, responses, erasure).
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { clientContact, contactPii, engagement, type Tx } from "@veradact/db";
import { normalizeEmail } from "../auth/email-address";
import { DomainError } from "../errors";
import { runInTenant, type CommandContext } from "./context";

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
}

/** Creates `client_contact` + `contact_pii` with a fresh random 32-byte HMAC key. */
export async function addContact(ctx: CommandContext, input: AddContactInput): Promise<{ contactId: string }> {
  const name = cleanText(input.name, NAME_MAX);
  const email = cleanEmail(input.email);
  const title = cleanTitle(input.title);
  const contactId = input.contactId ?? randomUUID();
  return runInTenant(ctx, async (tx) => {
    const [found] = await tx.select({ id: engagement.id }).from(engagement).where(eq(engagement.id, input.engagementId));
    if (!found) throw new DomainError("engagement_not_found");
    await tx.insert(clientContact).values({ id: contactId, orgId: ctx.orgId, engagementId: input.engagementId, createdAt: ctx.clock() });
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
