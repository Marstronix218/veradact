import type { Metadata } from "next";
import { US_STATE_NAMES } from "@veradact/core";
import { Card } from "@/components";
import { clock } from "@/lib/clock";
import { localDateString } from "@/lib/dates";
import { requireEngagement } from "@/lib/engagement";
import { SourceForm } from "./source-form";

export const metadata: Metadata = { title: "Add source" };

const STATES = Object.entries(US_STATE_NAMES).sort(([a], [b]) => a.localeCompare(b));

export default async function NewSourcePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const e = await requireEngagement(id);
  return (
    <div className="max-w-3xl">
      <Card title="Add a source" description="Notes, a transcript, an email thread or a chat export. Text only: recordings are never accepted.">
        <SourceForm engagementId={e.id} defaultDate={localDateString(clock(), e.timeZone)} states={STATES} aiActive={e.aiActive} />
      </Card>
    </div>
  );
}
