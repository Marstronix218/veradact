// Persists the deterministic metrics scenario (`buildMetricsScenario`, expected 60% on target)
// into a real tenant through the real commands and append path, with a fake clock that replays the
// scenario's timestamps, plus its link and usage rows. For integration tests, e2e and the seed.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { confirmationLink, org, usageEvent, type Tx } from "@veradact/db";
import {
  addContact,
  createEngagement,
  createItem,
  recordAuthorization,
  recordClientResponses,
  requestConfirmation,
  reviseItem,
} from "../commands";
import type { MetricsSummary } from "../domain";
// Imported directly (not via `domain/testing`) so fast-check, a dev dependency, is not pulled in.
import { buildMetricsScenario } from "../domain/testing/metrics-scenario";
import { AUTHORIZATION_TEXT_VERSION, renderAuthorizationText } from "../confirmation/authorization-text";

export interface SeedMetricsScenarioInput {
  orgId: string;
  /** The member who "did" the vendor actions. */
  userId: string;
  /** The scenario is laid out in business days before `now`. */
  now: Date;
  timeZone?: string;
  /** Default `PILOT`; must be unused in the org. */
  shortCode?: string;
}

export interface SeededMetricsScenario {
  engagementId: string;
  shortCode: string;
  /** The numbers `computeEngagementMetrics` must produce for this engagement at `now`. */
  expected: Omit<MetricsSummary, "confirmDurationsMs">;
}

const CONTACTS: Record<string, { name: string; email: string }> = {
  ops: { name: "Olive Ops", email: "olive.ops@halvorsen.example" },
  cfo: { name: "Casey Finance", email: "casey.finance@halvorsen.example" },
};

/**
 * Replays the scenario's log event by event through `createEngagement`, `addContact`, `createItem`,
 * `reviseItem`, `requestConfirmation`, `recordAuthorization` and `recordClientResponses` inside `tx`
 * (already scoped to `orgId`), then copies its link timestamps and usage rows.
 */
export async function seedMetricsScenario(tx: Tx, input: SeedMetricsScenarioInput): Promise<SeededMetricsScenario> {
  const scenario = buildMetricsScenario({ now: input.now, ...(input.timeZone ? { timeZone: input.timeZone } : {}) });
  const { builder, input: metricsInput } = scenario;
  const shortCode = input.shortCode ?? builder.shortCode;
  let current = new Date(0);
  const clock = () => new Date(current.getTime());
  const ctx = { tx, orgId: input.orgId, userId: input.userId, clock };
  const client = { tx, orgId: input.orgId, clock };
  const evidence = { ip: null, userAgent: null };

  const [vendor] = await tx.select({ name: org.name }).from(org).where(eq(org.id, input.orgId));
  const contactLabel = new Map(Object.keys(CONTACTS).map((label) => [builder.id(`contact:${label}`), label]));
  const ids = new Map<string, string>(); // scenario id → real id (items, contacts, requests)
  const hashes = new Map<string, string>(); // scenario content hash → real content hash
  const real = (id: string) => {
    const mapped = ids.get(id);
    if (!mapped) throw new Error("seedMetricsScenario: unknown scenario id");
    return mapped;
  };
  let engagementId = "";
  let authText = "";

  for (const e of metricsInput.events) {
    current = e.recordedAt;
    switch (e.type) {
      case "engagement_created": {
        const p = e.payload;
        ({ engagementId } = await createEngagement(ctx, { name: p.name, clientName: p.client_name, shortCode, timeZone: p.time_zone }));
        authText = renderAuthorizationText({ vendorName: vendor?.name ?? "", engagementName: p.name, clientName: p.client_name });
        for (const [scenarioId, label] of contactLabel) {
          const { contactId } = await addContact(ctx, { engagementId, ...CONTACTS[label]! });
          ids.set(scenarioId, contactId);
        }
        break;
      }
      case "item_created": {
        const p = e.payload;
        const created = await createItem(ctx, { engagementId, kind: p.kind, statement: p.statement, manual: true, occurredAt: e.occurredAt });
        ids.set(p.item_id, created.itemId);
        hashes.set(p.content_hash, created.contentHash);
        break;
      }
      case "item_revised": {
        const p = e.payload;
        const revised = await reviseItem(ctx, { engagementId, itemId: real(p.item_id), statement: p.statement, reasonCode: p.reason_code });
        hashes.set(p.content_hash, revised.contentHash);
        break;
      }
      case "confirmation_requested": {
        const p = e.payload;
        const created = await requestConfirmation(ctx, {
          engagementId,
          items: p.items.map((i) => ({ itemId: real(i.item_id) })),
          contactIds: p.contact_ids.map(real),
          expiresAt: new Date(p.expires_at),
        });
        ids.set(p.request_id, created.requestId);
        break;
      }
      case "authorization_granted":
      case "authorization_declined": {
        const p = e.payload;
        await recordAuthorization(client, {
          engagementId,
          requestId: real(p.request_id),
          contactId: real(p.contact_id),
          decision: e.type === "authorization_granted" ? "granted" : "declined",
          text: authText,
          textVersion: AUTHORIZATION_TEXT_VERSION,
          evidence,
        });
        break;
      }
      case "item_confirmed":
      case "item_disputed": {
        const p = e.payload;
        const contentHash = hashes.get(p.content_hash);
        if (!contentHash) throw new Error("seedMetricsScenario: unknown item version");
        await recordClientResponses(client, {
          channel: "email_link",
          engagementId,
          requestId: real(p.request_id),
          contactId: real(p.contact_id),
          submissionId: randomUUID(),
          responses: [
            {
              itemId: real(p.item_id),
              version: p.version,
              contentHash,
              decision: e.type === "item_confirmed" ? "confirmed" : "disputed",
              comment: e.type === "item_disputed" ? "This does not match what we discussed." : null,
            },
          ],
          evidence,
        });
        break;
      }
      default:
        throw new Error(`seedMetricsScenario: unsupported event type ${e.type}`);
    }
  }

  for (const l of metricsInput.links) {
    await tx
      .update(confirmationLink)
      .set({
        emailSentAt: l.emailSentAt,
        firstOpenedAt: l.firstOpenedAt,
        lastOpenedAt: l.firstOpenedAt,
        openCount: l.openCount,
        firstInteractionAt: l.firstInteractionAt,
        revokedAt: l.revokedAt,
      })
      .where(and(eq(confirmationLink.requestId, real(l.requestId)), eq(confirmationLink.contactId, real(l.contactId))));
  }
  if (metricsInput.usage.length) {
    await tx.insert(usageEvent).values(
      metricsInput.usage.map((u) => ({ orgId: input.orgId, engagementId, kind: u.kind, userId: input.userId, createdAt: u.createdAt })),
    );
  }
  return { engagementId, shortCode, expected: scenario.expected };
}
