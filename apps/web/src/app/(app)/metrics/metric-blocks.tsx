// Display pieces for the pilot metrics (ARCHITECTURE §12), shared by /metrics and the
// engagement confirmations page. Server components; no client JavaScript.
import type { ReactNode } from "react";
import { RATE_KILL, RATE_TARGET, type MetricsSummary, type RateBand } from "@veradact/core";
import { Badge, type BadgeTone } from "@/components";

export const BAND_LABELS: Record<RateBand, string> = {
  on_target: "On target",
  watch: "Watch",
  kill_signal: "Kill signal",
  insufficient_data: "Not enough data",
};

const BAND_TONES: Record<RateBand, BadgeTone> = { on_target: "green", watch: "yellow", kill_signal: "red", insufficient_data: "neutral" };

const BAND_FILL: Record<RateBand, string> = {
  on_target: "bg-green-600",
  watch: "bg-amber-500",
  kill_signal: "bg-red-600",
  insufficient_data: "bg-zinc-300",
};

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

const MARKS = [
  { at: RATE_KILL, label: "Kill" },
  { at: RATE_TARGET, label: "Target" },
] as const;

/** The rate on a 0–100% track with the kill and target marks; `compact` drops the mark labels (table cells). */
export function RateMeter({ m, compact = false, className = "" }: { m: Pick<MetricsSummary, "confirmationRate" | "rateBand">; compact?: boolean; className?: string }) {
  const rate = m.confirmationRate;
  return (
    <div
      className={className}
      role="img"
      aria-label={`${rate === null ? "Not enough data yet" : percent(rate)}; target ${percent(RATE_TARGET)}, kill signal below ${percent(RATE_KILL)}`}
    >
      <div className={`relative rounded-full bg-zinc-100 ${compact ? "h-1.5" : "h-2.5"}`}>
        {rate === null ? null : <div className={`absolute inset-y-0 left-0 rounded-full ${BAND_FILL[m.rateBand]}`} style={{ width: `${Math.min(rate, 1) * 100}%` }} />}
        {MARKS.map((mark) => (
          <span key={mark.label} className="absolute -inset-y-1 w-0.5 -translate-x-1/2 rounded-full bg-zinc-400" style={{ left: `${mark.at * 100}%` }} />
        ))}
      </div>
      {compact ? null : (
        <div className="relative mt-1.5 h-4 text-[11px] text-zinc-500">
          {MARKS.map((mark) => (
            <span key={mark.label} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${mark.at * 100}%` }}>
              {mark.label} {percent(mark.at)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return (
    <div className="rounded-xl border border-zinc-200/80 bg-white p-4 shadow-xs">
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{label}</dt>
      <dd className="mt-1.5 text-2xl font-semibold tabular-nums text-zinc-900">{value}</dd>
      {detail ? <dd className="mt-1 text-xs text-zinc-500">{detail}</dd> : null}
    </div>
  );
}

/** The headline 5-business-day confirmation rate with its band and thresholds. */
export function RateCard({ m, title = "Confirmed within 5 business days" }: { m: MetricsSummary; title?: string }) {
  return (
    <div className="rounded-xl border border-zinc-200/80 bg-white p-5 shadow-xs" data-testid="confirmation-rate">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold text-zinc-700">{title}</h2>
        <BandBadge band={m.rateBand} />
      </div>
      <p className="mt-2 flex flex-wrap items-baseline gap-x-3">
        <RateValue m={m} className="font-display text-5xl font-semibold tabular-nums" />
        <span className="text-sm text-zinc-500">
          {m.versionsConfirmedInWindow} of {m.versionsMatured} matured item versions
        </span>
      </p>
      <RateMeter m={m} className="mt-4 max-w-xl" />
      <p className="mt-3 text-sm text-zinc-600">
        Target is {percent(RATE_TARGET)} or more; below {percent(RATE_KILL)} is the kill signal. Only versions sent at least 5 business days ago count (
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
