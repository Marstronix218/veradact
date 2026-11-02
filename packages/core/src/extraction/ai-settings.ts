// The engagement-level AI switch (ARCHITECTURE §9.3, §14). The org-level switch is
// `updateOrgSettings({ patch: { aiEnabled } })` (admin only). Both audit `ai.toggle` with
// before/after; enforcement is server-side in `runExtraction`.
import { eq } from "drizzle-orm";
import { engagement } from "@veradact/db";
import { writeAudit } from "../audit";
import { runInTenant, type CommandContext } from "../commands";
import { DomainError } from "../errors";

export interface SetEngagementAiInput {
  engagementId: string;
  enabled: boolean;
}

/** Sets `engagement.ai_enabled`; a change writes audit `ai.toggle` `{scope: "engagement", before, after}`. */
export async function setEngagementAiEnabled(ctx: CommandContext, input: SetEngagementAiInput): Promise<{ before: boolean; after: boolean }> {
  const after = input.enabled === true;
  return runInTenant(ctx, async (tx) => {
    const [row] = await tx.select({ aiEnabled: engagement.aiEnabled }).from(engagement).where(eq(engagement.id, input.engagementId)).for("update");
    if (!row) throw new DomainError("engagement_not_found");
    const before = row.aiEnabled;
    if (before === after) return { before, after };
    await tx.update(engagement).set({ aiEnabled: after }).where(eq(engagement.id, input.engagementId));
    await writeAudit(tx, {
      orgId: ctx.orgId,
      actorUserId: ctx.userId,
      action: "ai.toggle",
      targetType: "engagement",
      targetId: input.engagementId,
      metadata: { scope: "engagement", before, after },
      at: ctx.clock(),
    });
    return { before, after };
  });
}
