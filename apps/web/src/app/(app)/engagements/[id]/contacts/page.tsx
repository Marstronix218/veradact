import type { Metadata } from "next";
import { listContacts } from "@veradact/core";
import { ActionForm, Badge, Button, Card, Checkbox, EmptyState, Input, Table, TBody, Td, Th, THead, Tr } from "@/components";
import { requireEngagement } from "@/lib/engagement";
import { formatDate } from "@/lib/format";
import { withAuthTenant } from "@/lib/session";
import { addContactAction, eraseContactAction } from "./actions";

export const metadata: Metadata = { title: "Contacts" };

export default async function ContactsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const e = await requireEngagement(id);
  const contacts = await withAuthTenant((tx) => listContacts(tx, e.id));

  return (
    <div className="space-y-6">
      <Card title="Add a client contact" description="People at the client who confirm items. They need no account.">
        <ActionForm action={addContactAction} preserveValues className="grid gap-4 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
          <input type="hidden" name="engagementId" value={e.id} />
          <Input name="name" label="Name" required maxLength={200} autoComplete="off" />
          <Input name="email" type="email" label="Email" required maxLength={254} autoComplete="off" />
          <Input name="title" label="Title (optional)" maxLength={200} autoComplete="off" />
          <Button type="submit">Add contact</Button>
        </ActionForm>
      </Card>

      {contacts.length === 0 ? (
        <EmptyState title="No contacts yet" description="Add the client people who will confirm items." />
      ) : (
        <Table>
          <THead>
            <Tr>
              <Th>Name</Th>
              <Th>Email</Th>
              <Th>Title</Th>
              <Th>Authorization</Th>
              <Th>Added</Th>
              <Th className="text-right">Erase</Th>
            </Tr>
          </THead>
          <TBody>
            {contacts.map((c) => (
              <Tr key={c.id} data-testid="contact-row">
                <Td className="font-medium text-zinc-900">{c.erased ? <span className="text-zinc-500">{c.name}</span> : c.name}</Td>
                <Td className="text-zinc-600">{c.email ?? "—"}</Td>
                <Td className="text-zinc-600">{c.title ?? "—"}</Td>
                <Td>
                  {c.erased ? (
                    <Badge>Erased {c.erasedAt ? formatDate(c.erasedAt, e.timeZone) : ""}</Badge>
                  ) : c.authorization ? (
                    <Badge tone={c.authorization.decision === "granted" ? "green" : "red"}>
                      {c.authorization.decision === "granted" ? "Granted" : "Declined"} {formatDate(c.authorization.recordedAt, e.timeZone)}
                    </Badge>
                  ) : (
                    <span className="text-sm text-zinc-500">Not yet asked</span>
                  )}
                </Td>
                <Td className="whitespace-nowrap text-zinc-600">{formatDate(c.createdAt, e.timeZone)}</Td>
                <Td className="text-right">
                  {c.erased ? null : (
                    <details className="inline-block text-left">
                      <summary className="cursor-pointer text-sm font-medium text-red-700">Erase…</summary>
                      <div className="mt-2 w-80 space-y-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
                        <p>
                          Erasing deletes this contact&apos;s name, email and title, the identity and IP snapshots taken when they responded, and their dispute
                          comments. Their open confirmation links stop working.
                        </p>
                        <p>
                          The ledger keeps an anonymized trace: their confirmations and disputes remain as &quot;Erased contact&quot;, and the hash chain still
                          verifies. This cannot be undone.
                        </p>
                        <ActionForm action={eraseContactAction} confirmMessage="Erase this contact's personal data permanently?" className="space-y-3">
                          <input type="hidden" name="engagementId" value={e.id} />
                          <input type="hidden" name="contactId" value={c.id} />
                          <Checkbox id={`understood-${c.id}`} name="understood" required label="I understand this cannot be undone." />
                          <Button type="submit" variant="danger" size="sm">
                            Erase personal data
                          </Button>
                        </ActionForm>
                      </div>
                    </details>
                  )}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}
