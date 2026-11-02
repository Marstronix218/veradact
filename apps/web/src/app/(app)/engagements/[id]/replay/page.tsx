import type { Metadata } from "next";
import { EmptyState } from "@/components";

export const metadata: Metadata = { title: "Replay" };

export default function ReplayPage() {
  return (
    <EmptyState
      title="Replay is coming soon"
      description="Pick a past date to see what was known and what was agreed at that time, and compare two dates."
    />
  );
}
