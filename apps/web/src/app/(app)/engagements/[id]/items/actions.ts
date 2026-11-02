"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  addDependency,
  clearReview,
  createItem,
  removeDependency,
  reviseItem,
  supersedeItem,
  ValidationError,
  withdrawItem,
  type CommandContext,
  type Kind,
  type ReviseReason,
  type SupersedeReason,
  type WithdrawReason,
} from "@veradact/core";
import { withTenant } from "@veradact/db";
import { runAction } from "@/lib/actions";
import { commandContext, field } from "@/lib/commands";
import { parseLocalDate } from "@/lib/dates";
import { getEngagement } from "@/lib/engagement";
import type { FormState } from "@/lib/form-state";
import { enumValue, KIND_LABELS, REVISE_REASON_LABELS, SUPERSEDE_REASON_LABELS, WITHDRAW_REASON_LABELS } from "@/lib/labels";

function revalidateEngagement(engagementId: string): void {
  revalidatePath(`/engagements/${engagementId}`, "layout");
}

type Done = "withdrawn" | "superseded" | "dependency_added" | "dependency_removed" | "review_cleared";

/**
 * Runs an item action whose form disappears afterwards (the item stops being active, or the
 * choice is gone) and lands back on the item page with a confirmation notice.
 */
async function itemAction(formData: FormData, done: Done, fn: (ctx: CommandContext, engagementId: string, itemId: string) => Promise<unknown>): Promise<FormState> {
  const engagementId = field(formData, "engagementId");
  const itemId = field(formData, "itemId");
  let ok = false;
  const state = await runAction(async () => {
    await fn(await commandContext(), engagementId, itemId);
    revalidateEngagement(engagementId);
    ok = true;
  });
  if (ok) redirect(`/engagements/${engagementId}/items/${itemId}?done=${done}`);
  return state;
}

function ids(formData: FormData, name: string): string[] {
  return [...new Set(formData.getAll(name).filter((v): v is string => typeof v === "string" && v.trim() !== ""))];
}

/**
 * Manual entry: kind, statement, optional source + exact quote (the server finds and verifies the
 * offsets), dependencies. Without a source the version is "entered manually by" the member. With
 * `supersedes`, the new item replaces that item in the same transaction.
 */
export async function createItemAction(_prev: FormState, formData: FormData): Promise<FormState> {
  let destination: string | undefined;
  const state = await runAction(async () => {
    const ctx = await commandContext();
    const engagement = await getEngagement(field(formData, "engagementId"));
    if (!engagement) throw new ValidationError("That engagement does not exist.");
    const kind = enumValue<Kind>(KIND_LABELS, field(formData, "kind"));
    if (!kind) throw new ValidationError("Choose a kind.", "kind");
    const sourceId = field(formData, "sourceId");
    const quote = String(formData.get("quote") ?? "").trim();
    if (sourceId && !quote) throw new ValidationError("Paste the exact quote from the source, or choose no source.", "quote");
    if (quote && !sourceId) throw new ValidationError("Choose the source the quote comes from.", "sourceId");
    const date = field(formData, "date");
    const supersedes = field(formData, "supersedes");
    const supersedeReason = supersedes ? enumValue<SupersedeReason>(SUPERSEDE_REASON_LABELS, field(formData, "supersedeReason")) : undefined;
    if (supersedes && !supersedeReason) throw new ValidationError("Choose why the item is superseded.", "supersedeReason");

    const created = await withTenant(ctx.db, { orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
      const inTx: CommandContext = { tx, orgId: ctx.orgId, userId: ctx.userId, clock: ctx.clock };
      const item = await createItem(inTx, {
        engagementId: engagement.id,
        kind,
        statement: field(formData, "statement"),
        ...(sourceId ? { spans: [{ sourceId, quote }] } : { manual: true }),
        dependsOn: ids(formData, "dependsOn"),
        ...(!sourceId && date ? { occurredAt: parseLocalDate(date, engagement.timeZone, "date") } : {}),
      });
      if (supersedes && supersedeReason) {
        await supersedeItem(inTx, { engagementId: engagement.id, itemId: supersedes, supersededByItemId: item.itemId, reasonCode: supersedeReason });
      }
      return item;
    });
    revalidateEngagement(engagement.id);
    destination = `/engagements/${engagement.id}/items/${created.shortId}?created=1`;
  });
  if (destination) redirect(destination);
  return state;
}

/** New version: statement, kept/removed spans, an optional added quote, reason code and note. */
export async function reviseItemAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return runAction(async () => {
    const ctx = await commandContext();
    const engagementId = field(formData, "engagementId");
    const reasonCode = enumValue<ReviseReason>(REVISE_REASON_LABELS, field(formData, "reasonCode"));
    if (!reasonCode) throw new ValidationError("Choose a reason for the revision.", "reasonCode");
    const kept = new Set(ids(formData, "keepSpan"));
    const removeSpans = ids(formData, "currentSpan")
      .filter((key) => !kept.has(key))
      .map((key) => {
        const [sourceId, start, end] = key.split(":");
        return { sourceId: sourceId!, start: Number(start), end: Number(end) };
      });
    const addSourceId = field(formData, "addSourceId");
    const addQuote = String(formData.get("addQuote") ?? "").trim();
    if (addQuote && !addSourceId) throw new ValidationError("Choose the source of the added quote.", "addSourceId");
    if (addSourceId && !addQuote) throw new ValidationError("Paste the exact quote to add, or choose no source.", "addQuote");
    const expected = Number(field(formData, "expectedVersion"));
    const result = await reviseItem(ctx, {
      engagementId,
      itemId: field(formData, "itemId"),
      statement: field(formData, "statement"),
      reasonCode,
      removeSpans,
      addSpans: addSourceId ? [{ sourceId: addSourceId, quote: addQuote }] : [],
      ...(Number.isSafeInteger(expected) && expected > 0 ? { expectedVersion: expected } : {}),
      note: field(formData, "note") || null,
    });
    revalidateEngagement(engagementId);
    return `Saved version ${result.version}. It is pending until the client confirms it.`;
  });
}

export async function withdrawItemAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return itemAction(formData, "withdrawn", async (ctx, engagementId, itemId) => {
    const reasonCode = enumValue<WithdrawReason>(WITHDRAW_REASON_LABELS, field(formData, "reasonCode"));
    if (!reasonCode) throw new ValidationError("Choose a reason.", "reasonCode");
    await withdrawItem(ctx, { engagementId, itemId, reasonCode, note: field(formData, "note") || null });
  });
}

export async function supersedeItemAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return itemAction(formData, "superseded", async (ctx, engagementId, itemId) => {
    const reasonCode = enumValue<SupersedeReason>(SUPERSEDE_REASON_LABELS, field(formData, "reasonCode"));
    if (!reasonCode) throw new ValidationError("Choose a reason.", "reasonCode");
    const supersededByItemId = field(formData, "supersededByItemId");
    if (!supersededByItemId) throw new ValidationError("Choose the replacement item.", "supersededByItemId");
    await supersedeItem(ctx, { engagementId, itemId, supersededByItemId, reasonCode, note: field(formData, "note") || null });
  });
}

export async function addDependencyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return itemAction(formData, "dependency_added", async (ctx, engagementId, itemId) => {
    const dependsOnItemId = field(formData, "dependsOnItemId");
    if (!dependsOnItemId) throw new ValidationError("Choose an item.", "dependsOnItemId");
    await addDependency(ctx, { engagementId, itemId, dependsOnItemId });
  });
}

export async function removeDependencyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return itemAction(formData, "dependency_removed", (ctx, engagementId, itemId) =>
    removeDependency(ctx, { engagementId, itemId, dependsOnItemId: field(formData, "dependsOnItemId") }),
  );
}

export async function clearReviewAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return itemAction(formData, "review_cleared", (ctx, engagementId, itemId) => clearReview(ctx, { engagementId, itemId }));
}
