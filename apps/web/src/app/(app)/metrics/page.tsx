import type { Metadata } from "next";
import { EmptyState, PageHeader } from "@/components";

export const metadata: Metadata = { title: "Metrics" };

export default function MetricsPage() {
  return (
    <>
      <PageHeader title="Metrics" description="Confirmation rate, time to confirm and disputes across engagements." />
      <EmptyState
        title="No metrics yet"
        description="Metrics appear once items have been sent to clients for confirmation."
      />
    </>
  );
}
