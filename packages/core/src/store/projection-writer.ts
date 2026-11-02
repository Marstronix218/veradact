// Projection writer (ARCHITECTURE §5.2 step 4, §5.3): deletes every projection row of the
// engagement and inserts `projectRows(state)`. The live path and the rebuild path both use it,
// so "rebuild equals live" holds by construction (D-006). A diffing writer can replace this
// behind the same signature (§15).
import { eq } from "drizzle-orm";
import {
  confirmationRequest,
  confirmationRequestContact,
  confirmationRequestItem,
  contactAuthorization,
  item,
  itemDependency,
  itemResponse,
  itemVersion,
  source,
  type Tx,
} from "@veradact/db";
import { projectRows, type EngagementState } from "../domain";

/** Rows per INSERT statement (well under Postgres' 65,535 bind parameters for every table). */
const CHUNK = 500;

async function insertChunked<T>(rows: readonly T[], insert: (chunk: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) await insert(rows.slice(i, i + CHUNK));
}

/**
 * Replaces the engagement's projection rows with those derived from `state`. `engagementId`
 * defaults to `state.engagement.id`; pass it explicitly to clear the rows of an engagement whose
 * state is empty. Must run inside the engagement's append lock (append or rebuild).
 */
export async function writeProjections(
  tx: Tx,
  state: EngagementState,
  engagementId: string | undefined = state.engagement?.id,
): Promise<void> {
  if (engagementId === undefined) return;
  if (state.engagement && state.engagement.id !== engagementId) {
    throw new Error("writeProjections: state belongs to a different engagement");
  }

  await tx.delete(source).where(eq(source.engagementId, engagementId));
  await tx.delete(item).where(eq(item.engagementId, engagementId));
  await tx.delete(itemVersion).where(eq(itemVersion.engagementId, engagementId));
  await tx.delete(itemDependency).where(eq(itemDependency.engagementId, engagementId));
  await tx.delete(itemResponse).where(eq(itemResponse.engagementId, engagementId));
  await tx.delete(confirmationRequest).where(eq(confirmationRequest.engagementId, engagementId));
  await tx.delete(confirmationRequestItem).where(eq(confirmationRequestItem.engagementId, engagementId));
  await tx.delete(confirmationRequestContact).where(eq(confirmationRequestContact.engagementId, engagementId));
  await tx.delete(contactAuthorization).where(eq(contactAuthorization.engagementId, engagementId));

  const rows = projectRows(state);
  await insertChunked(rows.source, (chunk) => tx.insert(source).values(chunk));
  await insertChunked(rows.item, (chunk) => tx.insert(item).values(chunk));
  await insertChunked(rows.item_version, (chunk) => tx.insert(itemVersion).values(chunk));
  await insertChunked(rows.item_dependency, (chunk) => tx.insert(itemDependency).values(chunk));
  await insertChunked(rows.item_response, (chunk) => tx.insert(itemResponse).values(chunk));
  await insertChunked(rows.confirmation_request, (chunk) =>
    tx.insert(confirmationRequest).values(
      chunk.map((r) => {
        // Validated drafts always carry a user actor for confirmation_requested (D-035).
        if (r.requestedBy === null) throw new Error("writeProjections: confirmation request without requester");
        return { ...r, requestedBy: r.requestedBy };
      }),
    ),
  );
  await insertChunked(rows.confirmation_request_item, (chunk) => tx.insert(confirmationRequestItem).values(chunk));
  await insertChunked(rows.confirmation_request_contact, (chunk) => tx.insert(confirmationRequestContact).values(chunk));
  await insertChunked(rows.contact_authorization, (chunk) => tx.insert(contactAuthorization).values(chunk));
}
