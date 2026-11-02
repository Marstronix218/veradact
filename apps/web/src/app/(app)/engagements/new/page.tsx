import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm, Button, buttonClasses, Card, Input, PageHeader, Select } from "@/components";
import { requireAuth } from "@/lib/session";
import { COMMON_TIME_ZONES, DEFAULT_TIME_ZONE } from "@/lib/time-zones";
import { createEngagementAction } from "./actions";

export const metadata: Metadata = { title: "New engagement" };

export default async function NewEngagementPage() {
  await requireAuth();
  return (
    <div className="max-w-2xl">
      <PageHeader title="New engagement" description="One client project with its own ledger, sources and confirmations." />
      <Card>
        <ActionForm action={createEngagementAction} className="space-y-4">
          <Input name="name" label="Engagement name" required maxLength={200} placeholder="e.g. Dispatch assistant pilot" />
          <Input name="clientName" label="Client name" required maxLength={200} placeholder="e.g. Halvorsen Freight" />
          <Input
            name="shortCode"
            label="Short code"
            required
            minLength={2}
            maxLength={8}
            pattern="[A-Za-z0-9]{2,8}"
            className="font-mono uppercase"
            hint="2 to 8 letters or digits. Item ids start with it (HALV-R7). It can't be changed later."
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Select name="timeZone" label="Time zone" defaultValue={DEFAULT_TIME_ZONE} hint="Used for source dates, reminders and business days.">
              {COMMON_TIME_ZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </Select>
            <Input name="timeZoneOther" label="Other time zone" placeholder="e.g. America/Halifax" maxLength={64} hint="Only if yours isn't listed (IANA name)." />
          </div>
          <div className="flex gap-2">
            <Button type="submit">Create engagement</Button>
            <Link href="/engagements" className={buttonClasses("secondary")}>
              Cancel
            </Link>
          </div>
        </ActionForm>
      </Card>
    </div>
  );
}
