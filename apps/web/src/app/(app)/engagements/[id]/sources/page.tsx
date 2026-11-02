import type { Metadata } from "next";
import Link from "next/link";
import { listSources } from "@veradact/core";
import { Badge, buttonClasses, EmptyState, Table, TBody, Td, Th, THead, Tr } from "@/components";
import { requireEngagement } from "@/lib/engagement";
import { formatDate } from "@/lib/format";
import { SOURCE_TYPE_LABELS } from "@/lib/labels";
import { withAuthTenant } from "@/lib/session";

export const metadata: Metadata = { title: "Sources" };

export default async function SourcesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const e = await requireEngagement(id);
  const sources = await withAuthTenant((tx) => listSources(tx, e.id));
  const base = `/engagements/${e.id}/sources`;
  const addSource = (
    <Link href={`${base}/new`} className={buttonClasses()}>
      Add source
    </Link>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-zinc-600">Notes, transcripts, emails and chat exports, with their consent attestations.</p>
        {sources.length > 0 ? addSource : null}
      </div>
      {sources.length === 0 ? (
        <EmptyState title="No sources yet" description="Paste or upload text from a meeting, an email thread or a chat export.">
          {addSource}
        </EmptyState>
      ) : (
        <Table>
          <THead>
            <Tr>
              <Th>Title</Th>
              <Th>Type</Th>
              <Th>Date</Th>
              <Th>Participants</Th>
              <Th>Added</Th>
            </Tr>
          </THead>
          <TBody>
            {sources.map((s) => (
              <Tr key={s.id}>
                <Td className="font-medium text-zinc-900">
                  <Link href={`${base}/${s.id}`} className="hover:underline">
                    {s.redactedAt ? "Redacted source" : (s.title ?? s.filename ?? "Untitled source")}
                  </Link>
                  {s.redactedAt ? (
                    <span className="ml-2">
                      <Badge tone="red">Redacted</Badge>
                    </span>
                  ) : null}
                </Td>
                <Td className="text-zinc-600">
                  {SOURCE_TYPE_LABELS[s.sourceType]}
                  <span className="ml-1 text-xs text-zinc-400">.{s.format}</span>
                </Td>
                <Td className="whitespace-nowrap text-zinc-600">{formatDate(s.occurredAt, e.timeZone)}</Td>
                <Td className="text-zinc-600">{s.participantCount}</Td>
                <Td className="whitespace-nowrap text-zinc-600">{formatDate(s.recordedAt, e.timeZone)}</Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}
