import type { Metadata } from "next";
import Link from "next/link";
import { listItems, listSources, UUID_PATTERN } from "@veradact/core";
import { ActionForm, Button, buttonClasses, Card, Input, Notice, Select, Textarea } from "@/components";
import { requireEngagement } from "@/lib/engagement";
import { formatDate } from "@/lib/format";
import { KIND_LABELS, SUPERSEDE_REASON_LABELS } from "@/lib/labels";
import { withAuthTenant } from "@/lib/session";
import { createItemAction } from "../actions";

export const metadata: Metadata = { title: "Add item" };

type Search = { source?: string; notice?: string; supersedes?: string };

export default async function NewItemPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  const { id } = await params;
  const search = await searchParams;
  const e = await requireEngagement(id);
  const { sources, items } = await withAuthTenant(async (tx) => ({
    sources: (await listSources(tx, e.id)).filter((s) => !s.redactedAt),
    items: await listItems(tx, e.id, { lifecycle: "active" }),
  }));
  const preselected = search.source && sources.some((s) => s.id === search.source) ? search.source : "";
  const supersedes = search.supersedes && UUID_PATTERN.test(search.supersedes) ? items.find((i) => i.id === search.supersedes) : undefined;

  return (
    <div className="max-w-3xl space-y-4">
      {search.notice === "ai_off" ? (
        <Notice>
          <span data-testid="ai-off-notice">
            The source was added. AI suggestions are off for this {e.orgAiEnabled ? "engagement" : "organization"}, so no text was sent to any model provider:
            enter the items yourself.
          </span>
        </Notice>
      ) : null}
      <Card
        title={supersedes ? `Replace ${supersedes.shortId}` : "Add an item"}
        description={
          supersedes
            ? `The new item supersedes ${supersedes.shortId}: “${supersedes.statement}”.`
            : "Cite the exact words from a source, or leave the source empty to record the item as entered manually by you."
        }
      >
        <ActionForm action={createItemAction} preserveValues className="space-y-4">
          <input type="hidden" name="engagementId" value={e.id} />
          {supersedes ? <input type="hidden" name="supersedes" value={supersedes.id} /> : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Select name="kind" label="Kind" defaultValue={supersedes?.kind ?? "requirement"}>
              {Object.entries(KIND_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
            {supersedes ? (
              <Select name="supersedeReason" label="Why is it superseded?" defaultValue="new_information">
                {Object.entries(SUPERSEDE_REASON_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            ) : null}
          </div>
          <Textarea
            name="statement"
            label="Statement"
            rows={3}
            required
            maxLength={2000}
            defaultValue={supersedes?.statement}
            hint="One clear sentence. Don't include personal data (names, emails, phone numbers): statements become part of the permanent, tamper-evident record and cannot be erased."
          />
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <Select name="sourceId" label="Source (optional)" defaultValue={preselected}>
              <option value="">No source (entered manually)</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {(s.title ?? s.filename ?? "Untitled source") + ` · ${formatDate(s.occurredAt, e.timeZone)}`}
                </option>
              ))}
            </Select>
            <Textarea
              name="quote"
              label="Exact quote"
              rows={3}
              maxLength={2000}
              hint="Copy the words exactly as they appear in the source. If they appear more than once, use a longer quote."
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <label htmlFor="dependsOn" className="block text-sm font-medium text-zinc-800">
                Depends on (decisions and requirements only)
              </label>
              <select id="dependsOn" name="dependsOn" multiple size={Math.min(6, Math.max(3, items.length))} className="block w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm">
                {items.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.shortId} · {i.statement.length > 80 ? `${i.statement.slice(0, 80)}…` : i.statement}
                  </option>
                ))}
              </select>
              <p className="text-xs text-zinc-500">Hold Ctrl or Cmd to pick several.</p>
            </div>
            <Input name="date" type="date" label="Date agreed (manual items, optional)" hint="Sourced items take the source's date." />
          </div>
          <div className="flex gap-2">
            <Button type="submit">{supersedes ? "Create replacement" : "Add item"}</Button>
            <Link href={`/engagements/${e.id}`} className={buttonClasses("secondary")}>
              Cancel
            </Link>
          </div>
        </ActionForm>
      </Card>
    </div>
  );
}
