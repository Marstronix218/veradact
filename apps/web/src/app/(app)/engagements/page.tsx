import type { Metadata } from "next";
import Link from "next/link";
import { Badge, buttonClasses, EmptyState, PageHeader, Table, TBody, Td, Th, THead, Tr } from "@/components";
import { withAuthTenant } from "@/lib/session";

export const metadata: Metadata = { title: "Engagements" };

function formatDate(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export default async function EngagementsPage() {
  const engagements = await withAuthTenant((tx) =>
    tx.query.engagement.findMany({
      columns: { id: true, name: true, clientName: true, shortCode: true, status: true, timeZone: true, createdAt: true },
      orderBy: (e, { asc, desc }) => [asc(e.status), desc(e.createdAt)],
    }),
  );

  // The form lives at /engagements/new (core's createEngagement command).
  const newEngagement = (
    <Link href="/engagements/new" className={buttonClasses()}>
      New engagement
    </Link>
  );

  return (
    <>
      <PageHeader
        title="Engagements"
        description="Each engagement is one client project with its own ledger."
        actions={newEngagement}
      />
      {engagements.length === 0 ? (
        <EmptyState
          title="No engagements yet"
          description="Create an engagement for a client project, then add sources and items to its ledger."
        >
          {newEngagement}
        </EmptyState>
      ) : (
        <Table>
          <THead>
            <Tr>
              <Th>Name</Th>
              <Th>Client</Th>
              <Th>Code</Th>
              <Th>Status</Th>
              <Th>Created</Th>
            </Tr>
          </THead>
          <TBody>
            {engagements.map((e) => (
              <Tr key={e.id}>
                <Td className="font-medium text-zinc-900">
                  <Link href={`/engagements/${e.id}`} className="hover:underline">
                    {e.name}
                  </Link>
                </Td>
                <Td>{e.clientName}</Td>
                <Td>
                  <span className="font-mono text-xs">{e.shortCode}</span>
                </Td>
                <Td>
                  <Badge tone={e.status === "active" ? "green" : "neutral"}>
                    {e.status === "active" ? "Active" : "Archived"}
                  </Badge>
                </Td>
                <Td className="whitespace-nowrap text-zinc-600">{formatDate(e.createdAt, e.timeZone)}</Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
    </>
  );
}
