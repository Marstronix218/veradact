// Audit log (ARCHITECTURE §2.4, §14). Append-only for the app role; written inside the same
// tenant transaction as the change it records, so a rolled-back change leaves no audit row.
import { auditLog, type Tx } from "@veradact/db";
import type { SafeFields } from "./log";

export const AUDIT_ACTIONS = [
  "auth.signup",
  "auth.login",
  "auth.logout",
  "source.ingest",
  "source.redact",
  "ai.toggle",
  "engagement.create",
  "engagement.update",
  "confirmation.request",
  "confirmation.revoke",
  "export.spec",
  "export.record_md",
  "export.record_pdf",
  "contact.erase",
  "contact.outside_domains",
  "user.invite",
  "user.deactivate",
  "api_token.create",
  "api_token.revoke",
  "settings.update",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** What an audit row points at. Append new target types here. */
export type AuditTargetType =
  | "org"
  | "user"
  | "session"
  | "api_token"
  | "engagement"
  | "source"
  | "confirmation_request"
  | "contact";

export interface AuditEntry<M extends object = Record<never, never>> {
  orgId: string;
  /** Null for system actions (jobs). */
  actorUserId: string | null;
  action: AuditAction;
  targetType?: AuditTargetType | null;
  targetId?: string | null;
  /**
   * Ids, enums, counts and booleans only (same rule as `log`): wrap ids in `logId()`.
   * Never names, emails, IPs, tokens or free text.
   */
  metadata?: M & SafeFields<M>;
  /** From the injected clock. */
  at: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

function assertSafeMetadata(metadata: object): void {
  for (const [key, value] of Object.entries(metadata)) {
    const ok =
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value)) ||
      (typeof value === "string" && (UUID.test(value) || (TOKEN.test(value) && !value.includes("@"))));
    if (!TOKEN.test(key) || !ok) {
      // The key is a code constant; the value is never echoed.
      throw new Error(`writeAudit: metadata "${TOKEN.test(key) ? key : "?"}" must be an id, enum, count or boolean`);
    }
  }
}

export async function writeAudit<M extends object = Record<never, never>>(
  tx: Tx,
  entry: AuditEntry<M>,
): Promise<void> {
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry.metadata ?? {})) {
    if (value !== undefined) metadata[key] = value;
  }
  assertSafeMetadata(metadata);
  await tx.insert(auditLog).values({
    orgId: entry.orgId,
    actorUserId: entry.actorUserId,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    metadata,
    createdAt: entry.at,
  });
}
