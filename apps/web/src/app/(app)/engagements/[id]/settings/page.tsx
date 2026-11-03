import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm, Badge, Button, Card, Input, Notice, Select } from "@/components";
import { requireEngagement } from "@/lib/engagement";
import { COMMON_TIME_ZONES } from "@/lib/time-zones";
import { setClientEmailDomainsAction, setEngagementAiAction, setEngagementStatusAction, updateEngagementAction } from "./actions";

export const metadata: Metadata = { title: "Engagement settings" };

export default async function EngagementSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const e = await requireEngagement(id);
  const listed = (COMMON_TIME_ZONES as readonly string[]).includes(e.timeZone);

  return (
    <div className="max-w-2xl space-y-6">
      <Card title="Engagement" description={`Short code ${e.shortCode} (it can't be changed).`}>
        <ActionForm action={updateEngagementAction} preserveValues className="space-y-4">
          <input type="hidden" name="engagementId" value={e.id} />
          <Input name="name" label="Engagement name" required maxLength={200} defaultValue={e.name} />
          <Input name="clientName" label="Client name" required maxLength={200} defaultValue={e.clientName} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Select name="timeZone" label="Time zone" defaultValue={listed ? e.timeZone : "UTC"}>
              {COMMON_TIME_ZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </Select>
            <Input name="timeZoneOther" label="Other time zone" maxLength={64} defaultValue={listed ? "" : e.timeZone} hint="Only if yours isn't listed (IANA name)." />
          </div>
          <Button type="submit">Save</Button>
        </ActionForm>
      </Card>

      <Card
        title={
          <span className="flex items-center gap-2">
            AI suggestions {e.aiEnabled ? <Badge tone="violet">On</Badge> : <Badge>Off</Badge>}
          </span>
        }
        description="When AI is off, no source text from this engagement is sent to any model provider: members enter items manually, and spec exports and the MCP server omit quotes. Changes are recorded in the audit log."
      >
        {e.orgAiEnabled ? null : (
          <div className="mb-4">
            <Notice>
              AI is turned off for your whole organization, so it stays off here whatever this setting says. Admins can change that in{" "}
              <Link href="/settings" className="underline">
                organization settings
              </Link>
              .
            </Notice>
          </div>
        )}
        <ActionForm action={setEngagementAiAction} confirmMessage={e.aiEnabled ? undefined : "Turn AI suggestions on? Source text from this engagement will be sent to the model provider for extraction."}>
          <input type="hidden" name="engagementId" value={e.id} />
          <input type="hidden" name="enabled" value={e.aiEnabled ? "false" : "true"} />
          <Button type="submit" variant={e.aiEnabled ? "danger" : "secondary"}>
            {e.aiEnabled ? "Turn AI off" : "Turn AI on"}
          </Button>
        </ActionForm>
      </Card>

      <Card
        title="Client email domains"
        description="The email domains the client uses, such as client.example. Adding a contact with an address elsewhere then needs an explicit confirmation, which is recorded in the audit log, and confirmations show the confirmer's email domain. Leave empty to allow any address."
      >
        <ActionForm action={setClientEmailDomainsAction} preserveValues className="space-y-4">
          <input type="hidden" name="engagementId" value={e.id} />
          <Input name="domains" label="Domains" maxLength={2000} defaultValue={e.clientEmailDomains.join(", ")} hint="Separate several domains with commas. Subdomains are included." />
          <Button type="submit" variant="secondary">
            Save domains
          </Button>
        </ActionForm>
      </Card>

      <Card
        title="Status"
        description={
          e.status === "active"
            ? "Archive the engagement when the project ends. Its ledger stays readable and exportable; archived engagements don't count as active."
            : "This engagement is archived. Reactivate it to resume work."
        }
      >
        <ActionForm action={setEngagementStatusAction} confirmMessage={e.status === "active" ? "Archive this engagement?" : undefined}>
          <input type="hidden" name="engagementId" value={e.id} />
          <input type="hidden" name="status" value={e.status === "active" ? "archived" : "active"} />
          <Button type="submit" variant="secondary">
            {e.status === "active" ? "Archive engagement" : "Reactivate engagement"}
          </Button>
        </ActionForm>
      </Card>
    </div>
  );
}
