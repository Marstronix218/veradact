// Client contact read helpers. Erased contacts render as "Erased contact" with no PII (§6).
import { asc, eq } from "drizzle-orm";
import { clientContact, contactAuthorization, contactPii, type Tx } from "@veradact/db";
import type { AuthorizationDecision } from "../domain";
import { ERASED_CONTACT_NAME } from "./items";

export interface ContactRow {
  id: string;
  /** Contact name, or "Erased contact". */
  name: string;
  email: string | null;
  title: string | null;
  erased: boolean;
  erasedAt: Date | null;
  createdAt: Date;
  /** Latest authorization decision (D-019), if any. */
  authorization: { decision: AuthorizationDecision; textVersion: string; requestId: string; recordedAt: Date } | null;
}

export async function listContacts(tx: Tx, engagementId: string): Promise<ContactRow[]> {
  const rows = await tx
    .select({
      id: clientContact.id,
      erasedAt: clientContact.erasedAt,
      createdAt: clientContact.createdAt,
      name: contactPii.name,
      email: contactPii.email,
      title: contactPii.title,
      decision: contactAuthorization.decision,
      textVersion: contactAuthorization.textVersion,
      requestId: contactAuthorization.requestId,
      authorizedAt: contactAuthorization.recordedAt,
    })
    .from(clientContact)
    .leftJoin(contactPii, eq(contactPii.contactId, clientContact.id))
    .leftJoin(contactAuthorization, eq(contactAuthorization.contactId, clientContact.id))
    .where(eq(clientContact.engagementId, engagementId))
    .orderBy(asc(clientContact.createdAt), asc(clientContact.id));
  return rows.map((r) => {
    const erased = r.erasedAt !== null || r.name === null;
    return {
      id: r.id,
      name: erased ? ERASED_CONTACT_NAME : r.name!,
      email: erased ? null : r.email,
      title: erased ? null : r.title,
      erased,
      erasedAt: r.erasedAt,
      createdAt: r.createdAt,
      authorization:
        r.decision && r.textVersion && r.requestId && r.authorizedAt
          ? { decision: r.decision, textVersion: r.textVersion, requestId: r.requestId, recordedAt: r.authorizedAt }
          : null,
    };
  });
}
