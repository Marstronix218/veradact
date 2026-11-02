import type { Metadata } from "next";
import { EmptyState } from "@/components";

export const metadata: Metadata = { title: "Export" };

export default function ExportPage() {
  return (
    <EmptyState
      title="Export is coming soon"
      description="Download the confirmed spec for coding agents, or the full record with hash-chain verification as markdown or PDF."
    />
  );
}
