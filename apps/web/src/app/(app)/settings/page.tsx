import type { Metadata } from "next";
import {
  getOrgSettings,
  isAdmin,
  REMINDER_BUSINESS_DAYS_RANGE,
  RETENTION_DAYS_RANGE,
} from "@veradact/core";
import { ActionForm, Button, Card, Checkbox, Input, Notice } from "@/components";
import { getDb } from "@/lib/db";
import { requireAuth } from "@/lib/session";
import { updateSettingsAction } from "./actions";

export const metadata: Metadata = { title: "Organization settings" };

export default async function OrgSettingsPage() {
  const auth = await requireAuth();
  const settings = await getOrgSettings(getDb(), auth);
  const canEdit = isAdmin(auth);

  return (
    <div className="max-w-2xl space-y-6">
      {canEdit ? null : <Notice>Only admins can change organization settings.</Notice>}
      <ActionForm action={updateSettingsAction} className="space-y-6">
        <fieldset disabled={!canEdit} className="space-y-6">
          <Card title="Organization" description={`${settings.name} · ${settings.slug}`}>
            <Checkbox
              name="aiEnabled"
              label="Use AI to suggest items from sources"
              hint="When off, no source text is sent to any model provider for any engagement in this organization."
              defaultChecked={settings.aiEnabled}
            />
          </Card>

          <Card title="Retention">
            <Input
              name="retentionDays"
              type="number"
              label="Delete source text after (days)"
              hint="Measured from when a source was added. Leave empty to keep sources indefinitely."
              min={RETENTION_DAYS_RANGE.min}
              max={RETENTION_DAYS_RANGE.max}
              step={1}
              placeholder="Keep indefinitely"
              defaultValue={settings.retentionDays ?? ""}
            />
          </Card>

          <Card title="Recording consent">
            <div className="space-y-4">
              <Input
                name="allPartyStates"
                label="All-party consent states"
                hint="Two-letter US state codes, separated by commas. Machine transcripts from these states need every participant's consent."
                defaultValue={settings.allPartyStates.join(", ")}
              />
              <Checkbox
                name="blockUnknownJurisdictions"
                label="Block unattested machine transcripts from unknown locations"
                hint="If any participant's location is unknown, require a consent attestation before a machine transcript can be added."
                defaultChecked={settings.blockUnknownJurisdictions}
              />
            </div>
          </Card>

          <Card title="Reminders">
            <Input
              name="reminderBusinessDays"
              type="number"
              label="Send one reminder after (business days)"
              hint="Clients who haven't responded to a confirmation request get one reminder."
              min={REMINDER_BUSINESS_DAYS_RANGE.min}
              max={REMINDER_BUSINESS_DAYS_RANGE.max}
              step={1}
              required
              defaultValue={settings.reminderBusinessDays}
            />
          </Card>

          {canEdit ? (
            <div>
              <Button type="submit">Save settings</Button>
            </div>
          ) : null}
        </fieldset>
      </ActionForm>
    </div>
  );
}
