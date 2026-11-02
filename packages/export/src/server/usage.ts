// Usage metering rows (ARCHITECTURE §2.4, §10–§12): one per export or MCP fetch.
import { usageEvent, type Tx, type UsageEventKind } from "@veradact/db";

export interface RecordUsageInput {
  orgId: string;
  /** Null for org-level calls such as MCP `list_engagements`. */
  engagementId: string | null;
  kind: UsageEventKind;
  userId?: string | null;
  apiTokenId?: string | null;
  /** MCP tool name. */
  tool?: string | null;
  at: Date;
}

/** Inserts one `usage_event` row in the caller's tenant transaction. */
export async function recordUsage(tx: Tx, input: RecordUsageInput): Promise<void> {
  await tx.insert(usageEvent).values({
    orgId: input.orgId,
    engagementId: input.engagementId,
    kind: input.kind,
    userId: input.userId ?? null,
    apiTokenId: input.apiTokenId ?? null,
    tool: input.tool ?? null,
    createdAt: input.at,
  });
}
