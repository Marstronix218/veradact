// Engagement lookup shared by the engagement layout and its pages. Resolved once per request.
import { notFound } from "next/navigation";
import { cache } from "react";
import { UUID_PATTERN } from "@veradact/core";
import { withAuthTenant } from "./session";

export interface EngagementView {
  id: string;
  name: string;
  clientName: string;
  shortCode: string;
  timeZone: string;
  status: "active" | "archived";
  /** The engagement's own AI switch. */
  aiEnabled: boolean;
  /** The organization's AI switch. */
  orgAiEnabled: boolean;
  /** AI extraction runs only when both switches are on (ARCHITECTURE §9.3). */
  aiActive: boolean;
}

/** The engagement in the signed-in user's org, or null (unknown id or another tenant). */
export const getEngagement = cache(async (id: string): Promise<EngagementView | null> => {
  if (!UUID_PATTERN.test(id)) return null;
  return withAuthTenant(async (tx, auth) => {
    const row = await tx.query.engagement.findFirst({ where: (e, { eq }) => eq(e.id, id) });
    if (!row) return null;
    const orgRow = await tx.query.org.findFirst({ columns: { aiEnabled: true }, where: (o, { eq }) => eq(o.id, auth.orgId) });
    const orgAiEnabled = orgRow?.aiEnabled ?? false;
    return {
      id: row.id,
      name: row.name,
      clientName: row.clientName,
      shortCode: row.shortCode,
      timeZone: row.timeZone,
      status: row.status,
      aiEnabled: row.aiEnabled,
      orgAiEnabled,
      aiActive: row.aiEnabled && orgAiEnabled,
    };
  });
});

/** The engagement, or the not-found page. */
export async function requireEngagement(id: string): Promise<EngagementView> {
  const found = await getEngagement(id);
  if (!found) notFound();
  return found;
}
