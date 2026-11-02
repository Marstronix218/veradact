// Org settings (ARCHITECTURE §2.1, §13, §14). Everyone in the org can read them; only admins
// change them. Turning org AI on/off audits `ai.toggle`; other changes audit `settings.update`
// with before/after counts and booleans (never free text).
import { eq } from "drizzle-orm";
import { org, withTenant, type Db } from "@veradact/db";
import { writeAudit } from "../audit";
import { requireAdmin, type AuthContext } from "../auth/context";
import { US_STATE_NAMES } from "../domain/consent";
import { NotFoundError, ValidationError } from "../errors";

export interface OrgSettings {
  orgId: string;
  name: string;
  slug: string;
  aiEnabled: boolean;
  /** Null keeps sources forever. */
  retentionDays: number | null;
  /** Sorted two-letter US state/DC codes. */
  allPartyStates: string[];
  blockUnknownJurisdictions: boolean;
  reminderBusinessDays: number;
}

export interface OrgSettingsPatch {
  aiEnabled?: boolean;
  retentionDays?: number | null;
  allPartyStates?: readonly string[];
  blockUnknownJurisdictions?: boolean;
  reminderBusinessDays?: number;
}

export const RETENTION_DAYS_RANGE = { min: 1, max: 3650 } as const;
export const REMINDER_BUSINESS_DAYS_RANGE = { min: 1, max: 10 } as const;

const columns = {
  orgId: org.id,
  name: org.name,
  slug: org.slug,
  aiEnabled: org.aiEnabled,
  retentionDays: org.retentionDays,
  allPartyStates: org.allPartyStates,
  blockUnknownJurisdictions: org.blockUnknownJurisdictions,
  reminderBusinessDays: org.reminderBusinessDays,
};

export async function getOrgSettings(db: Db, ctx: AuthContext): Promise<OrgSettings> {
  const [row] = await withTenant(db, ctx, (tx) => tx.select(columns).from(org).where(eq(org.id, ctx.orgId)));
  if (!row) throw new NotFoundError();
  return row;
}

function intInRange(value: number, range: { min: number; max: number }, field: string, label: string): number {
  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    throw new ValidationError(`${label} must be a whole number from ${range.min} to ${range.max}.`, field);
  }
  return value;
}

/** Upper-cases, de-duplicates and sorts; rejects anything that is not a US state or DC code. */
export function normalizeStateCodes(codes: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of codes) {
    const code = raw.trim().toUpperCase();
    if (code === "") continue;
    if (!/^[A-Z]{2}$/.test(code) || !(code in US_STATE_NAMES)) {
      throw new ValidationError("All-party states must be two-letter US state codes, such as CA or WA.", "allPartyStates");
    }
    out.add(code);
  }
  return [...out].sort();
}

type ValidPatch = Omit<OrgSettingsPatch, "allPartyStates"> & { allPartyStates?: string[] };

function validatePatch(patch: OrgSettingsPatch): ValidPatch {
  const out: ValidPatch = {};
  if (patch.aiEnabled !== undefined) out.aiEnabled = Boolean(patch.aiEnabled);
  if (patch.blockUnknownJurisdictions !== undefined) {
    out.blockUnknownJurisdictions = Boolean(patch.blockUnknownJurisdictions);
  }
  if (patch.retentionDays !== undefined) {
    out.retentionDays =
      patch.retentionDays === null
        ? null
        : intInRange(patch.retentionDays, RETENTION_DAYS_RANGE, "retentionDays", "Retention");
  }
  if (patch.reminderBusinessDays !== undefined) {
    out.reminderBusinessDays = intInRange(
      patch.reminderBusinessDays,
      REMINDER_BUSINESS_DAYS_RANGE,
      "reminderBusinessDays",
      "Reminder delay",
    );
  }
  if (patch.allPartyStates !== undefined) out.allPartyStates = normalizeStateCodes(patch.allPartyStates);
  return out;
}

const sameStates = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((code, i) => code === b[i]);

/** Admin only. Fields left undefined are unchanged; a no-op patch writes nothing. */
export async function updateOrgSettings(input: {
  db: Db;
  ctx: AuthContext;
  clock: () => Date;
  patch: OrgSettingsPatch;
}): Promise<OrgSettings> {
  const { db, ctx, clock } = input;
  requireAdmin(ctx);
  const patch = validatePatch(input.patch);
  const now = clock();

  return withTenant(db, ctx, async (tx) => {
    const [before] = await tx.select(columns).from(org).where(eq(org.id, ctx.orgId)).for("update");
    if (!before) throw new NotFoundError();
    const after: OrgSettings = { ...before, ...patch, allPartyStates: patch.allPartyStates ?? before.allPartyStates };

    const aiChanged = after.aiEnabled !== before.aiEnabled;
    const changes: Record<string, number | boolean | null> = {};
    if (after.retentionDays !== before.retentionDays) {
      changes.retention_days_before = before.retentionDays;
      changes.retention_days_after = after.retentionDays;
    }
    if (!sameStates([...after.allPartyStates].sort(), [...before.allPartyStates].sort())) {
      changes.all_party_states_count_before = before.allPartyStates.length;
      changes.all_party_states_count_after = after.allPartyStates.length;
    }
    if (after.blockUnknownJurisdictions !== before.blockUnknownJurisdictions) {
      changes.block_unknown_jurisdictions_before = before.blockUnknownJurisdictions;
      changes.block_unknown_jurisdictions_after = after.blockUnknownJurisdictions;
    }
    if (after.reminderBusinessDays !== before.reminderBusinessDays) {
      changes.reminder_business_days_before = before.reminderBusinessDays;
      changes.reminder_business_days_after = after.reminderBusinessDays;
    }
    if (!aiChanged && Object.keys(changes).length === 0) return before;

    await tx
      .update(org)
      .set({
        aiEnabled: after.aiEnabled,
        retentionDays: after.retentionDays,
        allPartyStates: after.allPartyStates,
        blockUnknownJurisdictions: after.blockUnknownJurisdictions,
        reminderBusinessDays: after.reminderBusinessDays,
      })
      .where(eq(org.id, ctx.orgId));

    if (aiChanged) {
      await writeAudit(tx, {
        orgId: ctx.orgId,
        actorUserId: ctx.userId,
        action: "ai.toggle",
        targetType: "org",
        targetId: ctx.orgId,
        metadata: { scope: "org", before: before.aiEnabled, after: after.aiEnabled },
        at: now,
      });
    }
    if (Object.keys(changes).length > 0) {
      await writeAudit(tx, {
        orgId: ctx.orgId,
        actorUserId: ctx.userId,
        action: "settings.update",
        targetType: "org",
        targetId: ctx.orgId,
        metadata: changes,
        at: now,
      });
    }
    return after;
  });
}
