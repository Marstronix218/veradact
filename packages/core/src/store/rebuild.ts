// Rebuild path (ARCHITECTURE §5.3) and a deterministic dump of the projection tables, used to
// check that the live tables equal a rebuild and equal `projectRows(fold(events))`.
import { asc, eq } from "drizzle-orm";
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
import type { EngagementState, ProjectionRows } from "../domain";
import { lockEngagement } from "./append";
import { loadState } from "./load-state";
import { writeProjections } from "./projection-writer";

/** Folds the full log from `emptyState()` and rewrites the projections with the live writer. */
export async function rebuildProjections(tx: Tx, engagementId: string): Promise<EngagementState> {
  await lockEngagement(tx, engagementId);
  const state = await loadState(tx, engagementId);
  await writeProjections(tx, state, engagementId);
  return state;
}

/**
 * Every projection row of the engagement, per table, in `PROJECTION_SORT_KEYS` order, with the same
 * shape as `projectRows` (camelCase keys, Dates, parsed jsonb) so the two can be compared directly.
 */
export async function dumpProjections(tx: Tx, engagementId: string): Promise<ProjectionRows> {
  const [
    sources,
    items,
    versions,
    dependencies,
    responses,
    requests,
    requestItems,
    requestContacts,
    authorizations,
  ] = await Promise.all([
    tx.select().from(source).where(eq(source.engagementId, engagementId)).orderBy(asc(source.id)),
    tx.select().from(item).where(eq(item.engagementId, engagementId)).orderBy(asc(item.id)),
    tx
      .select()
      .from(itemVersion)
      .where(eq(itemVersion.engagementId, engagementId))
      .orderBy(asc(itemVersion.itemId), asc(itemVersion.version)),
    tx
      .select()
      .from(itemDependency)
      .where(eq(itemDependency.engagementId, engagementId))
      .orderBy(asc(itemDependency.itemId), asc(itemDependency.dependsOnItemId)),
    tx.select().from(itemResponse).where(eq(itemResponse.engagementId, engagementId)).orderBy(asc(itemResponse.eventSeq)),
    tx
      .select()
      .from(confirmationRequest)
      .where(eq(confirmationRequest.engagementId, engagementId))
      .orderBy(asc(confirmationRequest.id)),
    tx
      .select()
      .from(confirmationRequestItem)
      .where(eq(confirmationRequestItem.engagementId, engagementId))
      .orderBy(asc(confirmationRequestItem.requestId), asc(confirmationRequestItem.itemId)),
    tx
      .select()
      .from(confirmationRequestContact)
      .where(eq(confirmationRequestContact.engagementId, engagementId))
      .orderBy(asc(confirmationRequestContact.requestId), asc(confirmationRequestContact.contactId)),
    tx
      .select()
      .from(contactAuthorization)
      .where(eq(contactAuthorization.engagementId, engagementId))
      .orderBy(asc(contactAuthorization.contactId)),
  ]);
  // jsonb columns come back as plain JSON; their static types are `unknown`.
  return {
    source: sources,
    item: items,
    item_version: versions,
    item_dependency: dependencies,
    item_response: responses,
    confirmation_request: requests,
    confirmation_request_item: requestItems,
    confirmation_request_contact: requestContacts,
    contact_authorization: authorizations,
  } as unknown as ProjectionRows;
}
