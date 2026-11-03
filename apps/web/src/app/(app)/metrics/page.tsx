import type { Metadata } from "next";
import Link from "next/link";
import { loadOrgMetrics } from "@veradact/core";
import { Badge, buttonClasses, EmptyState, PageHeader, Table, TBody, Td, Th, THead, Tr } from "@/components";
import { clock } from "@/lib/clock";
import { withAuthTenant } from "@/lib/session";
import { BandBadge, hours, MetricTiles, percent, RateCard, RateMeter, RateValue } from "./metric-blocks";

export const metadata: Metadata = { title: "Metrics" };

export default async function MetricsPage() {
  const now = clock();
  const { org, engagements } = await withAuthTenant((tx) => loadOrgMetrics(tx, now));

  return (
    <>
      <PageHeader
        title="Metrics"
        description="Whether clients confirm what you send them, per organization and per engagement."
        actions={
          <a href="/api/metrics.csv" className={buttonClasses("secondary")} download>
            Download CSV
          </a>
        }
      />
      {engagements.length === 0 ? (
        <EmptyState title="No metrics yet" description="Metrics appear once items have been sent to clients for confirmation." />
      ) : (
        <div className="space-y-8">
          <section className="space-y-4" aria-label="Organization summary">
            <RateCard m={org} title="Organization · confirmed within 5 business days" />
            <MetricTiles m={org} />
          </section>

          <section className="space-y-3">
            <h2 className="font-display text-2xl font-semibold text-ink-950">By engagement</h2>
            <Table>
              <THead>
                <Tr>
                  <Th>Engagement</Th>
                  <Th>5-day rate</Th>
                  <Th>Matured / maturing / pulled</Th>
                  <Th>Median time</Th>
                  <Th>Dispute rate</Th>
                  <Th>Link engagement</Th>
                  <Th>Churn</Th>
                  <Th>Spec exports</Th>
                  <Th>MCP fetches</Th>
                </Tr>
              </THead>
              <TBody>
                {engagements.map((m) => (
                  <Tr key={m.engagementId} data-testid={`metrics-row-${m.shortCode}`}>
                    <Td>
                      <Link href={`/engagements/${m.engagementId}/confirmations`} className="font-medium text-zinc-900 underline">
                        {m.name}
                      </Link>{" "}
                      <span className="font-mono text-xs text-zinc-500">{m.shortCode}</span>
                      {m.status === "archived" ? (
                        <span className="ml-2">
                          <Badge>Archived</Badge>
                        </span>
                      ) : null}
                    </Td>
                    <Td className="whitespace-nowrap">
                      <RateValue m={m} className="font-semibold tabular-nums" /> <BandBadge band={m.rateBand} />
                      <RateMeter m={m} compact className="mt-2 w-28" />
                    </Td>
                    <Td className="whitespace-nowrap">
                      {m.versionsMatured} / {m.versionsMaturing} / {m.versionsPulled}
                    </Td>
                    <Td className="whitespace-nowrap">{hours(m.medianHoursToConfirm)}</Td>
                    <Td className="whitespace-nowrap">{percent(m.disputeRate)}</Td>
                    <Td className="whitespace-nowrap">
                      {percent(m.linkEngagementRate)} <span className="text-xs text-zinc-500">({m.openCount} raw opens)</span>
                    </Td>
                    <Td className="whitespace-nowrap">{m.churnRevisions}</Td>
                    <Td className="whitespace-nowrap">{m.specExports}</Td>
                    <Td className="whitespace-nowrap">{m.mcpFetches}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
            <p className="text-xs text-zinc-500">
              Rates count item versions: a revised item sent again is a new attempt. Link engagement counts links where the client pressed a
              button; raw opens include mail-scanner prefetches. Churn counts revisions of items that had been confirmed. Times use each
              engagement&apos;s time zone.
            </p>
          </section>
        </div>
      )}
    </>
  );
}
