// Engagement commands (ARCHITECTURE §2.1, §3). The engagement row is operational; its name,
// client name and time zone are mirrored from `engagement_created` / `engagement_updated`.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { engagement, getPgError, type Tx } from "@veradact/db";
import { writeAudit } from "../audit";
import type { EngagementState, StoredEvent } from "../domain";
import { DomainError } from "../errors";
import { appendEvents } from "../store";
import { fixedClock, lockAndLoad, runInTenant, userActor, type CommandContext } from "./context";

export const SHORT_CODE_PATTERN = /^[A-Z0-9]{2,8}$/;
const NAME_MAX = 200;
const IANA_ZONE_SHAPE = /^(?:UTC|[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+)$/;

/** An IANA zone name (`Area/Location` or `UTC`) that the runtime's time zone database knows. */
export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone.length > 64 || !IANA_ZONE_SHAPE.test(timeZone)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function cleanName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > NAME_MAX) throw new DomainError("invalid_name");
  return trimmed;
}

export interface CreateEngagementInput {
  /** Defaults to a random UUID. */
  engagementId?: string;
  name: string;
  clientName: string;
  /** 2-8 characters A-Z/0-9, unique per org, immutable. */
  shortCode: string;
  /** IANA time zone. */
  timeZone: string;
  aiEnabled?: boolean;
}

export interface EngagementCommandResult {
  engagementId: string;
  events: StoredEvent[];
  state: EngagementState;
}

/** Creates the engagement row and appends the genesis `engagement_created` event. */
export async function createEngagement(ctx: CommandContext, input: CreateEngagementInput): Promise<EngagementCommandResult> {
  if (!SHORT_CODE_PATTERN.test(input.shortCode)) throw new DomainError("invalid_short_code");
  if (!isValidTimeZone(input.timeZone)) throw new DomainError("invalid_time_zone");
  const name = cleanName(input.name);
  const clientName = cleanName(input.clientName);
  const engagementId = input.engagementId ?? randomUUID();

  return runInTenant(ctx, async (tx) => {
    const taken = await tx
      .select({ id: engagement.id })
      .from(engagement)
      .where(and(eq(engagement.orgId, ctx.orgId), eq(engagement.shortCode, input.shortCode)));
    if (taken.length > 0) throw new DomainError("short_code_taken");

    const now = ctx.clock();
    try {
      await tx.insert(engagement).values({
        id: engagementId,
        orgId: ctx.orgId,
        name,
        clientName,
        shortCode: input.shortCode,
        timeZone: input.timeZone,
        aiEnabled: input.aiEnabled ?? true,
        status: "active",
        createdBy: ctx.userId,
        createdAt: now,
      });
    } catch (error) {
      const pg = getPgError(error);
      if (pg?.code === "23505") {
        throw new DomainError(pg.constraint === "engagement_org_short_code_unique" ? "short_code_taken" : "engagement_exists");
      }
      throw error;
    }

    const { events, state } = await appendEvents(
      tx,
      engagementId,
      [
        {
          type: "engagement_created",
          actor: userActor(ctx.userId),
          payload: { engagement_id: engagementId, short_code: input.shortCode, name, client_name: clientName, time_zone: input.timeZone },
        },
      ],
      { clock: fixedClock(now) },
    );
    await writeAudit(tx, {
      orgId: ctx.orgId,
      actorUserId: ctx.userId,
      action: "engagement.create",
      targetType: "engagement",
      targetId: engagementId,
      at: now,
    });
    return { engagementId, events, state };
  });
}

export interface UpdateEngagementInput {
  engagementId: string;
  name?: string;
  clientName?: string;
  timeZone?: string;
  /** Always rejected with `short_code_immutable` when present. */
  shortCode?: string;
}

/** Appends `engagement_updated` with the changed fields and mirrors them on the engagement row. */
export async function updateEngagement(ctx: CommandContext, input: UpdateEngagementInput): Promise<EngagementCommandResult> {
  if (input.shortCode !== undefined) throw new DomainError("short_code_immutable");
  if (input.timeZone !== undefined && !isValidTimeZone(input.timeZone)) throw new DomainError("invalid_time_zone");
  const name = input.name === undefined ? undefined : cleanName(input.name);
  const clientName = input.clientName === undefined ? undefined : cleanName(input.clientName);

  return runInTenant(ctx, async (tx) => {
    const { state, engagement: current } = await lockAndLoad(tx, input.engagementId);
    const payload: { name?: string; client_name?: string; time_zone?: string } = {};
    if (name !== undefined && name !== current.name) payload.name = name;
    if (clientName !== undefined && clientName !== current.clientName) payload.client_name = clientName;
    if (input.timeZone !== undefined && input.timeZone !== current.timeZone) payload.time_zone = input.timeZone;
    if (Object.keys(payload).length === 0) throw new DomainError("nothing_to_update");

    const now = ctx.clock();
    const result = await appendEvents(
      tx,
      input.engagementId,
      [{ type: "engagement_updated", actor: userActor(ctx.userId), payload }],
      { clock: fixedClock(now), state },
    );
    const updated = result.state.engagement!;
    await tx
      .update(engagement)
      .set({ name: updated.name, clientName: updated.clientName, timeZone: updated.timeZone })
      .where(eq(engagement.id, input.engagementId));
    await writeAudit(tx, {
      orgId: ctx.orgId,
      actorUserId: ctx.userId,
      action: "engagement.update",
      targetType: "engagement",
      targetId: input.engagementId,
      metadata: { name: "name" in payload, client_name: "client_name" in payload, time_zone: "time_zone" in payload },
      at: now,
    });
    return { engagementId: input.engagementId, events: result.events, state: result.state };
  });
}

async function setStatus(tx: Tx, ctx: CommandContext, engagementId: string, status: "active" | "archived"): Promise<void> {
  const now = ctx.clock();
  const rows = await tx
    .update(engagement)
    .set({ status, archivedAt: status === "archived" ? now : null })
    .where(eq(engagement.id, engagementId))
    .returning({ id: engagement.id });
  if (rows.length === 0) throw new DomainError("engagement_not_found");
  await writeAudit(tx, {
    orgId: ctx.orgId,
    actorUserId: ctx.userId,
    action: "engagement.update",
    targetType: "engagement",
    targetId: engagementId,
    metadata: { status },
    at: now,
  });
}

/** Marks the engagement archived (row status only; no event). */
export async function archiveEngagement(ctx: CommandContext, input: { engagementId: string }): Promise<void> {
  await runInTenant(ctx, (tx) => setStatus(tx, ctx, input.engagementId, "archived"));
}

/** Marks the engagement active again (row status only; no event). */
export async function reactivateEngagement(ctx: CommandContext, input: { engagementId: string }): Promise<void> {
  await runInTenant(ctx, (tx) => setStatus(tx, ctx, input.engagementId, "active"));
}
