import type { Metadata } from "next";
import Link from "next/link";
import { ValidationError, verifyEngagementChain, type ChainFailureReason } from "@veradact/core";
import { loadSpec, parseAsOf } from "@veradact/export/server";
import { Badge, Button, buttonClasses, Card, Input, Notice } from "@/components";
import { ShieldAlertIcon, ShieldCheckIcon } from "@/components/icons";
import { clock } from "@/lib/clock";
import { localDateString } from "@/lib/dates";
import { requireEngagement } from "@/lib/engagement";
import { formatDateTime } from "@/lib/format";
import { withAuthTenant } from "@/lib/session";

export const metadata: Metadata = { title: "Export" };

const CHAIN_FAILURE: Record<ChainFailureReason, string> = {
  seq_gap: "an event is missing, duplicated or out of order",
  prev_hash_mismatch: "an event no longer links to the hash of the event before it",
  hash_mismatch: "an event's content no longer matches its recorded hash",
  truncated: "the log is shorter than, or diverges from, the recorded head",
};

export default async function ExportPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ as_of?: string }> }) {
  const { id } = await params;
  const e = await requireEngagement(id);
  const now = clock();
  const asOfInput = ((await searchParams).as_of ?? "").trim();
  let asOf: Date | null = null;
  let asOfInvalid = false;
  if (asOfInput !== "") {
    try {
      asOf = parseAsOf(asOfInput, e.timeZone);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      asOfInvalid = true;
    }
  }
  const { spec, verification } = await withAuthTenant(async (tx) => {
    const [spec, verification] = await Promise.all([loadSpec(tx, { engagementId: e.id, asOf, clock: () => now }), verifyEngagementChain(tx, e.id)]);
    return { spec, verification };
  });

  const api = `/api/engagements/${e.id}/export`;
  const specHref = `${api}/spec.md${asOf ? `?as_of=${encodeURIComponent(asOfInput)}` : ""}`;

  return (
    <div className="space-y-6">
      {e.aiActive ? null : (
        <Notice>
          AI is off for this engagement, so the spec and the record omit source quotes and titles and cite each source by type, date and character offsets: these files
          are made to be handed to coding agents. The app itself still shows full quotes.
        </Notice>
      )}

      <Card
        title="Record"
        description="The record is the artifact for scope disputes: the agreed items, every confirmation and dispute, and the full hash-chained event log with the verification result below. Client confirmation receipts carry the same head hash, so a history rewritten after a receipt was sent would not match it."
      >
        <div className="space-y-4">
          <div
            className={`flex gap-4 rounded-xl p-4 text-sm ring-1 ring-inset ${verification.ok ? "bg-green-50/50 ring-green-200" : "bg-red-50/70 ring-red-200"}`}
            data-testid="chain-status"
          >
            <div className={`flex size-11 shrink-0 items-center justify-center rounded-full bg-white ring-1 ${verification.ok ? "text-green-700 ring-green-200" : "text-red-700 ring-red-200"}`}>
              {verification.ok ? <ShieldCheckIcon className="size-6" /> : <ShieldAlertIcon className="size-6" />}
            </div>
            <div className="min-w-0 space-y-1">
              {verification.ok ? (
                <p className="flex flex-wrap items-center gap-2">
                  <Badge tone="green">Verified</Badge>
                  <span className="text-zinc-800">
                    Hash chain OK: all {verification.checked} events were re-hashed from the stored rows and each links to the event before it.
                  </span>
                </p>
              ) : (
                <>
                  <p className="flex flex-wrap items-center gap-2">
                    <Badge tone="red">Verification FAILED</Badge>
                    <span className="text-red-800">
                      {verification.reason ? CHAIN_FAILURE[verification.reason] : "the chain does not verify"}
                      {verification.firstBadSeq !== undefined ? ` (first bad seq ${verification.firstBadSeq})` : ""}.
                    </span>
                  </p>
                  <p className="text-zinc-700">
                    {verification.headSeq > 0 ? `Events 1–${verification.headSeq} verified; ` : "No events verified; "}
                    later entries must not be relied on. The record still downloads and states the failure.
                  </p>
                </>
              )}
              <p className="break-all text-xs text-zinc-500">
                {verification.ok ? "Head" : "Last verified event"}: seq {verification.headSeq} · <span className="font-mono text-zinc-700">{verification.headHash}</span>
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <a href={`${api}/record.md`} className={buttonClasses()} download>
              Download record (Markdown)
            </a>
            <a href={`${api}/record.pdf`} className={buttonClasses("secondary")} download>
              Download record (PDF)
            </a>
          </div>
        </div>
      </Card>

      <Card
        title="Confirmed spec"
        description={`Only client-confirmed item versions, grouped by kind, then a final "Not confirmed — do not build" list. Use it as a Spec Kit spec.md or drop it into the client's repository.`}
      >
        <div className="space-y-4">
          <form method="get" className="flex flex-wrap items-end gap-3" aria-label="Spec as of">
            <div className="w-44">
              <Input type="date" name="as_of" label="As of (optional)" defaultValue={asOf ? localDateString(asOf, e.timeZone) : ""} />
            </div>
            <Button type="submit" variant="secondary">
              Preview
            </Button>
            {asOfInput ? (
              <Link href={`/engagements/${e.id}/export`} className="pb-2 text-sm text-zinc-600 hover:underline">
                Current
              </Link>
            ) : null}
          </form>
          {asOfInvalid ? <Notice tone="error">That as-of date is not valid; showing the current spec.</Notice> : null}
          <p className="text-sm text-zinc-600" data-testid="spec-summary">
            {asOf ? (
              <>
                Agreed as of {formatDateTime(asOf, e.timeZone)} (end of that day, <span className="font-mono">{e.timeZone}</span>)
              </>
            ) : (
              "Agreed now"
            )}
            : {spec.view.items.length} confirmed, {spec.view.notConfirmed.length} not confirmed · log seq {spec.view.head.seq}.
          </p>
          <div className="flex flex-wrap gap-2">
            <a href={specHref} className={buttonClasses()} download>
              Download spec.md
            </a>
          </div>
          <pre
            className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-md border border-zinc-200 bg-zinc-50 p-4 font-mono text-xs leading-relaxed text-zinc-800"
            data-testid="spec-preview"
          >
            {spec.markdown}
          </pre>
        </div>
      </Card>

      <Card title="Coding agents">
        <p className="text-sm text-zinc-700">
          Coding agents such as Claude Code or Cursor can fetch the same confirmed spec directly from the Veradact MCP server (<code className="font-mono text-xs">get_confirmed_spec</code>,{" "}
          <code className="font-mono text-xs">list_unconfirmed</code>, <code className="font-mono text-xs">get_item</code>) instead of a downloaded file. Create a personal token in{" "}
          <Link href="/settings/api-tokens" className="text-blue-700 hover:underline">
            Settings → API tokens
          </Link>
          .
        </p>
      </Card>
    </div>
  );
}
