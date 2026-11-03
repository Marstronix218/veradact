import type { Metadata } from "next";
import Link from "next/link";
import { appUser } from "@veradact/db";
import {
  formatDateTime,
  formatShortDate,
  listConfirmationRequests,
  listContacts,
  listItems,
  listOpenDisputes,
  loadEngagementMetrics,
  type ConfirmationRequestView,
  type Kind,
  type LinkStatus,
  type RequestContactRow,
} from "@veradact/core";
import { ActionForm, Badge, Button, Card, EmptyState, Input, Table, TBody, Td, Th, THead, Tr, type BadgeTone } from "@/components";
import { clock } from "@/lib/clock";
import { requireEngagement, type EngagementView } from "@/lib/engagement";
import { enumValue, KIND_LABELS, STATUS_LABELS, STATUS_TONES } from "@/lib/labels";
import { withAuthTenant } from "@/lib/session";
import { BandBadge, MetricTiles, RateValue } from "../../../metrics/metric-blocks";
import { revokeConfirmationAction, sendConfirmationRequestAction } from "./actions";
import { EXPIRY_DAYS } from "./constants";

export const metadata: Metadata = { title: "Confirmations" };

const LINK_STATUS: Record<LinkStatus, { label: string; tone: BadgeTone }> = {
  not_sent: { label: "Not sent", tone: "red" },
  sent: { label: "Sent", tone: "neutral" },
  opened: { label: "Opened", tone: "blue" },
  interacted: { label: "Engaged", tone: "blue" },
  responded: { label: "Responded", tone: "green" },
  expired: { label: "Expired", tone: "yellow" },
  revoked: { label: "Revoked", tone: "neutral" },
};

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export default async function ConfirmationsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ kind?: string }> }) {
  const { id } = await params;
  const e = await requireEngagement(id);
  const kind = enumValue<Kind>(KIND_LABELS, (await searchParams).kind);
  const now = clock();

  const data = await withAuthTenant(async (tx) => {
    const [requestable, contacts, requests, disputes, metrics, users] = await Promise.all([
      listItems(tx, e.id, { lifecycle: "active", status: ["pending", "disputed"], ...(kind ? { kind } : {}) }),
      listContacts(tx, e.id),
      listConfirmationRequests(tx, e.id, { now }),
      listOpenDisputes(tx, e.id),
      loadEngagementMetrics(tx, e.id, now),
      tx.select({ id: appUser.id, name: appUser.name }).from(appUser),
    ]);
    return { requestable, contacts: contacts.filter((c) => !c.erased), requests, disputes, metrics, userNames: new Map(users.map((u) => [u.id, u.name])) };
  });
  const base = `/engagements/${e.id}`;

  return (
    <div className="space-y-10">
      {data.metrics ? (
        <section aria-label="Confirmation metrics" className="space-y-3">
          <div className="flex flex-wrap items-baseline gap-3">
            <h2 className="text-lg font-semibold">Confirmation metrics</h2>
            <span className="text-2xl font-semibold" data-testid="engagement-confirmation-rate">
              <RateValue m={data.metrics} />
            </span>
            <BandBadge band={data.metrics.rateBand} />
            <span className="text-sm text-zinc-500">
              confirmed within 5 business days · <Link href="/metrics" className="underline">all metrics</Link>
            </span>
          </div>
          <MetricTiles m={data.metrics} compact />
        </section>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">New confirmation request</h2>
        <Card>
          <ActionForm action={sendConfirmationRequestAction} className="space-y-6">
            <input type="hidden" name="engagementId" value={e.id} />
            <fieldset className="space-y-3">
              <legend className="text-sm font-semibold text-zinc-900">Items (active, pending or disputed at their current version)</legend>
              <nav className="flex flex-wrap gap-2 text-sm" aria-label="Filter items by kind">
                <KindLink base={base} kind={undefined} active={kind} />
                {(Object.keys(KIND_LABELS) as Kind[]).map((k) => (
                  <KindLink key={k} base={base} kind={k} active={kind} />
                ))}
              </nav>
              {data.requestable.length === 0 ? (
                <p className="text-sm text-zinc-600">No items to send{kind ? ` of kind ${KIND_LABELS[kind].toLowerCase()}` : ""}. Confirmed items cannot be sent again until they are revised.</p>
              ) : (
                <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200">
                  {data.requestable.map((item) => (
                    <li key={item.id} className="flex items-start gap-3 px-3 py-2">
                      <input
                        id={`item-${item.id}`}
                        type="checkbox"
                        name="item"
                        value={`${item.id}:${item.currentVersion}:${item.contentHash}`}
                        className="mt-1 size-4 rounded border-zinc-300"
                      />
                      <label htmlFor={`item-${item.id}`} className="flex-1 text-sm text-zinc-800">
                        <span className="font-mono text-xs text-zinc-500">{item.shortId}</span> {item.statement}{" "}
                        <span className="whitespace-nowrap text-xs text-zinc-500">
                          · {KIND_LABELS[item.kind]} · v{item.currentVersion}
                        </span>
                      </label>
                      <Badge dot tone={STATUS_TONES[item.status]}>{STATUS_LABELS[item.status]}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </fieldset>
            <fieldset className="space-y-2">
              <legend className="text-sm font-semibold text-zinc-900">Client contacts</legend>
              {data.contacts.length === 0 ? (
                <p className="text-sm text-zinc-600">
                  No contacts yet. <Link href={`${base}/contacts`} className="underline">Add a client contact</Link> first.
                </p>
              ) : (
                <ul className="space-y-2">
                  {data.contacts.map((c) => (
                    <li key={c.id} className="flex items-center gap-3">
                      <input id={`contact-${c.id}`} type="checkbox" name="contact" value={c.id} className="size-4 rounded border-zinc-300" />
                      <label htmlFor={`contact-${c.id}`} className="text-sm text-zinc-800">
                        {c.name} <span className="text-zinc-500">{c.email}</span>
                        {c.authorization?.decision === "declined" ? <span className="ml-2 text-xs text-red-700">declined authorization</span> : null}
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </fieldset>
            <div className="w-48">
              <Input
                name="expiresInDays"
                type="number"
                label="Link expires after (days)"
                min={EXPIRY_DAYS.min}
                max={EXPIRY_DAYS.max}
                step={1}
                defaultValue={EXPIRY_DAYS.default}
                required
              />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={data.requestable.length === 0 || data.contacts.length === 0}>
                Send request
              </Button>
              <p className="text-xs text-zinc-500">Each contact gets an email with a personal link. Nothing is sent until you press Send.</p>
            </div>
          </ActionForm>
        </Card>
      </section>

      <section className="space-y-3" aria-labelledby="disputes-heading">
        <h2 id="disputes-heading" className="text-lg font-semibold">
          Open disputes
        </h2>
        {data.disputes.length === 0 ? (
          <p className="text-sm text-zinc-600">No open disputes.</p>
        ) : (
          <ul className="space-y-3" data-testid="open-disputes">
            {data.disputes.map((d) => (
              <li key={`${d.itemId}:${d.contactId}`} className="rounded-lg border border-red-200 bg-white p-4">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Link href={`${base}/items/${d.itemId}`} className="font-mono text-xs font-medium underline">
                    {d.shortId}
                  </Link>
                  <Badge tone="red">Disputed</Badge>
                  <span className="text-zinc-600">
                    by {d.contactName} · v{d.version} · {formatDateTime(d.recordedAt, e.timeZone)}
                  </span>
                </div>
                <p className="mt-1 text-sm text-zinc-900">{d.statement}</p>
                {d.comment ? (
                  <blockquote className="mt-2 border-l-4 border-red-200 pl-3 text-sm text-zinc-800">{d.comment}</blockquote>
                ) : (
                  <p className="mt-2 text-xs text-zinc-500">Comment erased with the contact.</p>
                )}
                <Link href={`${base}/items/${d.itemId}`} className="mt-2 inline-block text-sm underline">
                  Revise or withdraw this item
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Requests</h2>
        {data.requests.length === 0 ? (
          <EmptyState title="No confirmation requests yet" description="Send items to client contacts above. Their responses appear here." />
        ) : (
          data.requests.map((r) => <RequestCard key={r.id} request={r} engagement={e} requestedBy={data.userNames.get(r.requestedBy) ?? "Unknown user"} />)
        )}
      </section>
    </div>
  );
}

function KindLink({ base, kind, active }: { base: string; kind: Kind | undefined; active: Kind | undefined }) {
  const current = kind === active;
  return (
    <Link
      href={kind ? `${base}/confirmations?kind=${kind}` : `${base}/confirmations`}
      aria-current={current ? "page" : undefined}
      className={`rounded-full px-3 py-1 ring-1 ring-inset ${current ? "bg-zinc-900 text-white ring-zinc-900" : "text-zinc-700 ring-zinc-300 hover:bg-zinc-50"}`}
    >
      {kind ? KIND_LABELS[kind] : "All kinds"}
    </Link>
  );
}

function responseCounts(c: RequestContactRow, itemCount: number): string {
  const confirmed = c.responses.filter((r) => r.response === "confirmed").length;
  const disputed = c.responses.filter((r) => r.response === "disputed").length;
  if (confirmed + disputed === 0) return `0 of ${itemCount}`;
  return [confirmed ? `${confirmed} confirmed` : null, disputed ? `${disputed} disputed` : null, `of ${itemCount}`].filter(Boolean).join(" · ");
}

function RequestCard({ request: r, engagement: e, requestedBy }: { request: ConfirmationRequestView; engagement: EngagementView; requestedBy: string }) {
  const tz = e.timeZone;
  const base = `/engagements/${e.id}`;
  const openContacts = r.contacts.filter((c) => c.linkStatus !== "revoked");
  const date = (d: Date | null) => (d ? formatShortDate(d, tz) : "—");
  return (
    <section className="space-y-4 rounded-xl border border-zinc-200/80 bg-white p-5" data-testid="confirmation-request" aria-label={`Request sent ${formatDateTime(r.recordedAt, tz)}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-zinc-900">
            {plural(r.items.length, "item", "items")} sent {formatDateTime(r.recordedAt, tz)} by {requestedBy}
          </p>
          <p className="text-xs text-zinc-500">
            {r.expired ? "Expired" : "Expires"} {formatDateTime(r.expiresAt, tz)}
          </p>
        </div>
        {!r.expired && openContacts.length > 0 ? (
          <ActionForm action={revokeConfirmationAction} confirmMessage="Revoke this request? Every contact's link will stop working.">
            <input type="hidden" name="engagementId" value={e.id} />
            <input type="hidden" name="requestId" value={r.id} />
            <Button type="submit" variant="danger" size="sm">
              Revoke request
            </Button>
          </ActionForm>
        ) : null}
      </div>

      <Table>
        <THead>
          <Tr>
            <Th>Item</Th>
            <Th>Sent version</Th>
            <Th>Status now</Th>
          </Tr>
        </THead>
        <TBody>
          {r.items.map((i) => (
            <Tr key={i.itemId} data-testid={`request-item-${i.shortId}`}>
              <Td>
                <Link href={`${base}/items/${i.itemId}`} className="font-mono text-xs underline">
                  {i.shortId}
                </Link>{" "}
                <span className="text-zinc-800">{i.statement}</span>
              </Td>
              <Td className="whitespace-nowrap">v{i.version}</Td>
              <Td className="whitespace-nowrap">
                <Badge dot tone={STATUS_TONES[i.currentStatus]}>{STATUS_LABELS[i.currentStatus]}</Badge>
                {i.changedSinceRequest ? (
                  <span className="ml-2 text-xs text-zinc-500">
                    {i.lifecycle === "active" ? `updated since this request (now v${i.currentVersion})` : i.lifecycle}
                  </span>
                ) : null}
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>

      <Table>
        <THead>
          <Tr>
            <Th>Contact</Th>
            <Th>Link</Th>
            <Th>Sent</Th>
            <Th>Opened</Th>
            <Th>Engaged</Th>
            <Th>Responses</Th>
            <Th>Reminder</Th>
            <Th>
              <span className="sr-only">Actions</span>
            </Th>
          </Tr>
        </THead>
        <TBody>
          {r.contacts.map((c) => (
            <Tr key={c.contactId} data-testid="request-contact">
              <Td className="font-medium text-zinc-900">{c.contactName}</Td>
              <Td>
                <Badge tone={LINK_STATUS[c.linkStatus].tone}>{LINK_STATUS[c.linkStatus].label}</Badge>
              </Td>
              <Td className="whitespace-nowrap">{date(c.emailSentAt)}</Td>
              <Td className="whitespace-nowrap">{c.openCount > 0 ? `${date(c.firstOpenedAt)} (${plural(c.openCount, "open", "opens")})` : "—"}</Td>
              <Td className="whitespace-nowrap">{date(c.firstInteractionAt)}</Td>
              <Td className="whitespace-nowrap" data-testid="response-counts">
                {responseCounts(c, r.items.length)}
              </Td>
              <Td className="whitespace-nowrap">{date(c.reminderSentAt)}</Td>
              <Td>
                {c.linkStatus !== "revoked" && c.linkStatus !== "expired" ? (
                  <ActionForm action={revokeConfirmationAction} confirmMessage={`Revoke ${c.contactName}'s link? It will stop working.`}>
                    <input type="hidden" name="engagementId" value={e.id} />
                    <input type="hidden" name="requestId" value={r.id} />
                    <input type="hidden" name="contactId" value={c.contactId} />
                    <Button type="submit" variant="secondary" size="sm">
                      Revoke link
                    </Button>
                  </ActionForm>
                ) : null}
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>
    </section>
  );
}
