import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getSourceDetail, UUID_PATTERN, type SourceCitation } from "@veradact/core";
import { ActionForm, Badge, Button, Card, Checkbox, Notice, Select, Textarea } from "@/components";
import { requireEngagement } from "@/lib/engagement";
import { formatDate, formatDateTime } from "@/lib/format";
import { REDACTION_REASON_LABELS, SOURCE_TYPE_LABELS } from "@/lib/labels";
import { withAuthTenant } from "@/lib/session";
import { redactSourceAction } from "../actions";

export const metadata: Metadata = { title: "Source" };

interface Piece {
  text: string;
  citations: SourceCitation[];
}

/** Splits `text` at every citation boundary; each piece lists the citations covering it. */
function highlight(text: string, citations: readonly SourceCitation[]): Piece[] {
  const cuts = new Set<number>([0, text.length]);
  for (const c of citations) {
    if (c.start >= 0 && c.end <= text.length && c.start < c.end) {
      cuts.add(c.start);
      cuts.add(c.end);
    }
  }
  const points = [...cuts].sort((a, b) => a - b);
  const pieces: Piece[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const [from, to] = [points[i]!, points[i + 1]!];
    pieces.push({ text: text.slice(from, to), citations: citations.filter((c) => c.start <= from && c.end >= to) });
  }
  return pieces;
}

export default async function SourcePage({ params }: { params: Promise<{ id: string; sourceId: string }> }) {
  const { id, sourceId } = await params;
  const e = await requireEngagement(id);
  if (!UUID_PATTERN.test(sourceId)) notFound();
  const data = await withAuthTenant(async (tx) => {
    const detail = await getSourceDetail(tx, e.id, sourceId);
    if (!detail) return null;
    const ids = [detail.ingestedBy, detail.attestation.attested_by];
    const users = await tx.query.appUser.findMany({ columns: { id: true, name: true }, where: (u, { inArray }) => inArray(u.id, ids) });
    return { detail, names: new Map(users.map((u) => [u.id, u.name])) };
  });
  if (!data) notFound();
  const { detail: s, names } = data;
  const a = s.attestation;
  const itemsBase = `/engagements/${e.id}/items`;
  const participants = Array.isArray(s.content?.participants) ? (s.content.participants as unknown[]).filter((p): p is string => typeof p === "string") : [];
  const consentLabel =
    a.all_participants_consented === true ? "All participants consented (attested)" : a.source_type === "machine_transcript" ? "Not attested" : "Not required";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold text-zinc-900">{s.redactedAt ? "Redacted source" : (s.title ?? s.filename ?? "Untitled source")}</h2>
        <Badge>{SOURCE_TYPE_LABELS[s.sourceType]}</Badge>
        {s.redactedAt ? <Badge tone="red">Redacted on {formatDate(s.redactedAt, e.timeZone)}</Badge> : null}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Details">
          <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1.5 text-sm">
            <dt className="text-zinc-500">Source date</dt>
            <dd>{formatDate(s.occurredAt, e.timeZone)}</dd>
            <dt className="text-zinc-500">Added</dt>
            <dd>
              {formatDateTime(s.recordedAt, e.timeZone)} by {names.get(s.ingestedBy) ?? "a user"}
            </dd>
            <dt className="text-zinc-500">Format</dt>
            <dd>.{s.format}</dd>
            <dt className="text-zinc-500">Length</dt>
            <dd>{s.charLength.toLocaleString("en-US")} characters</dd>
            <dt className="text-zinc-500">Content hash</dt>
            <dd className="truncate font-mono text-xs" title={s.contentSha256}>
              {s.contentSha256}
            </dd>
            <dt className="text-zinc-500">Participants</dt>
            <dd>{participants.length > 0 ? participants.join(", ") : s.redactedAt ? `${s.participantCount} (redacted)` : "None listed"}</dd>
          </dl>
        </Card>
        <Card title="Consent attestation">
          <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1.5 text-sm">
            <dt className="text-zinc-500">Attested by</dt>
            <dd>{names.get(a.attested_by) ?? "a user"}</dd>
            <dt className="text-zinc-500">Treated as</dt>
            <dd>{SOURCE_TYPE_LABELS[a.source_type]}</dd>
            <dt className="text-zinc-500">Consent</dt>
            <dd>{consentLabel}</dd>
            <dt className="text-zinc-500">Locations</dt>
            <dd>
              {a.participant_jurisdictions.length > 0 ? a.participant_jurisdictions.join(", ") : "None given"}
              {a.jurisdictions_known ? "" : " (some unknown)"}
            </dd>
            <dt className="text-zinc-500">Decision</dt>
            <dd>
              Allowed <span className="font-mono text-xs text-zinc-500">({a.rule})</span>
            </dd>
          </dl>
        </Card>
      </div>

      {s.content ? (
        <Card
          title="Text"
          description={s.citations.length > 0 ? "Highlighted quotes are cited by ledger items; select one to open the item." : "No item cites this source yet."}
        >
          {s.content.integrity === "mismatch" ? (
            <div className="mb-3">
              <Notice tone="error">The stored text no longer matches its recorded hash. Quotes from it are not shown on items.</Notice>
            </div>
          ) : null}
          <div className="max-h-[36rem] overflow-y-auto whitespace-pre-wrap rounded-md bg-zinc-50 p-4 font-mono text-xs leading-relaxed text-zinc-800" data-testid="source-text">
            {highlight(s.content.text, s.citations).map((piece, i) => {
              const first = piece.citations[0];
              if (!first) return <span key={i}>{piece.text}</span>;
              const current = piece.citations.some((c) => c.current);
              return (
                <mark key={i} className={current ? "rounded-sm bg-amber-100" : "rounded-sm bg-zinc-200"} title={piece.citations.map((c) => `${c.shortId} v${c.version}`).join(", ")}>
                  <Link href={`${itemsBase}/${first.shortId}`} className="text-inherit no-underline">
                    {piece.text}
                  </Link>
                </mark>
              );
            })}
          </div>
        </Card>
      ) : (
        <Notice>The text of this source was redacted. Items that cited it keep their citations, but the quotes can no longer be shown.</Notice>
      )}

      {s.content ? (
        <Card title="Redact this source" description="Deletes the text, title, participants and AI suggestions from this source. The ledger keeps a redaction record; items keep their citations without quotes.">
          <ActionForm
            action={redactSourceAction}
            confirmMessage="Redact this source? Its text is deleted permanently and cannot be restored."
            className="space-y-4"
          >
            <input type="hidden" name="engagementId" value={e.id} />
            <input type="hidden" name="sourceId" value={s.id} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Select name="reasonCode" label="Reason" defaultValue="user_request">
                {Object.entries(REDACTION_REASON_LABELS)
                  .filter(([value]) => value !== "retention")
                  .map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
              </Select>
              <Textarea name="note" label="Note (optional)" rows={2} maxLength={2000} hint="Kept outside the tamper-evident log." />
            </div>
            <Checkbox name="understood" required label="I understand the text will be deleted permanently." />
            <Button type="submit" variant="danger">
              Redact source
            </Button>
          </ActionForm>
        </Card>
      ) : null}
    </div>
  );
}
