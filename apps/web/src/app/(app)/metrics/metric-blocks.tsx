// Display pieces for the pilot metrics (ARCHITECTURE §12), shared by /metrics and the
// engagement confirmations page. Server components; no client JavaScript.
import type { ReactNode } from "react";
import type { MetricsSummary, RateBand } from "@veradact/core";
import { Badge, type BadgeTone } from "@/components";

export const BAND_LABELS: Record<RateBand, string> = {
  on_target: "On target",
  watch: "Watch",
  kill_signal: "Kill signal",
  insufficient_data: "Not enough data",
};

const BAND_TONES: Record<RateBand, BadgeTone> = { on_target: "green", watch: "yellow", kill_signal: "red", insufficient_data: "neutral" };

const BAND_TEXT: Record<RateBand, string> = {
  on_target: "text-green-700",
  watch: "text-amber-700",
  kill_signal: "text-red-700",
  insufficient_data: "text-zinc-500",
};

export function percent(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

export function hours(value: number | null): string {
  return value === null ? "—" : `${value} h`;
}

export function BandBadge({ band }: { band: RateBand }) {
  return <Badge tone={BAND_TONES[band]}>{BAND_LABELS[band]}</Badge>;
}

export function RateValue({ m, className = "" }: { m: Pick<MetricsSummary, "confirmationRate" | "rateBand">; className?: string }) {
  return <span className={`${BAND_TEXT[m.rateBand]} ${className}`}>{percent(m.confirmationRate)}</span>;
}

function Stat({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4">
      <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</dt>
      <dd className="mt-1 text-xl font-semibold text-zinc-900">{value}</dd>
      {detail ? <dd className="mt-1 text-xs text-zinc-500">{detail}</dd> : null}
    </div>
  );
}

/** The headline 5-business-day confirmation rate with its band and thresholds. */
export function RateCard({ m, title = "Confirmed within 5 business days" }: { m: MetricsSummary; title?: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5" data-testid="confirmation-rate">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold text-zinc-700">{title}</h2>
        <BandBadge band={m.rateBand} />
      </div>
      <p className="mt-2 text-4xl font-semibold tracking-tight">
        <RateValue m={m} />
        <span className="ml-3 text-sm font-normal text-zinc-500">
          {m.versionsConfirmedInWindow} of {m.versionsMatured} matured item versions
        </span>
      </p>
      <p className="mt-3 text-sm text-zinc-600">
        Target is 50% or more; below 25% is the kill signal. Only versions sent at least 5 business days ago count (
        {m.versionsMaturing} still maturing). Versions you revised, withdrew or superseded before the client answered are excluded as
        pulled ({m.versionsPulled}).
      </p>
    </div>
  );
}

/** The other metrics as a grid of tiles. */
export function MetricTiles({ m, compact = false }: { m: MetricsSummary; compact?: boolean }) {
  return (
    <dl className={`grid gap-3 ${compact ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4"}`}>
      <Stat label="Matured / maturing / pulled" value={`${m.versionsMatured} / ${m.versionsMaturing} / ${m.versionsPulled}`} detail={`${m.versionsSent} versions sent`} />
      <Stat label="Median time to confirm" value={hours(m.medianHoursToConfirm)} detail={`${m.timeToConfirmSamples} confirmed versions`} />
      <Stat label="Dispute rate" value={percent(m.disputeRate)} detail={`${m.versionsDisputed} of ${m.versionsSent} versions`} />
      <Stat
        label="Link engagement"
        value={percent(m.linkEngagementRate)}
        detail={`${m.linksInteracted} of ${m.linksSent} links used · raw opens ${m.linksOpened} links, ${m.openCount} total`}
      />
      {compact ? null : (
        <>
          <Stat label="Revised after confirmation" value={m.churnRevisions} detail={`${m.churnRequirementRevisions} requirements`} />
          <Stat label="Spec exports" value={m.specExports} detail={`${m.recordExports} record exports`} />
          <Stat label="MCP fetches" value={m.mcpFetches} />
        </>
      )}
    </dl>
  );
}
