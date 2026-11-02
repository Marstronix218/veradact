import type { Metadata } from "next";
import { isAdmin, listApiTokens } from "@veradact/core";
import { ActionForm, Badge, Button, Card, EmptyState, Table, TBody, Td, Th, THead, Tr } from "@/components";
import { getDb } from "@/lib/db";
import { mcpPublicUrl } from "@/lib/env";
import { requireAuth } from "@/lib/session";
import { revokeApiTokenAction } from "./actions";
import { CreateTokenForm } from "./create-token-form";

export const metadata: Metadata = { title: "API tokens" };

const dateTime = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
const formatDate = (date: Date | null) => (date ? `${dateTime.format(date)} UTC` : "Never");

export default async function ApiTokensPage() {
  const auth = await requireAuth();
  const tokens = await listApiTokens(getDb(), auth);
  const showOwner = isAdmin(auth);

  return (
    <div className="space-y-6">
      <Card
        title="Create an API token"
        description="Tokens let coding agents read confirmed specs through the Veradact MCP server. They act as you, read-only."
      >
        <CreateTokenForm mcpUrl={mcpPublicUrl()} />
      </Card>

      {tokens.length === 0 ? (
        <EmptyState title="No API tokens" description="Create a token to connect Claude Code, Cursor or another MCP client." />
      ) : (
        <Table>
          <THead>
            <Tr>
              <Th>Name</Th>
              <Th>Token</Th>
              {showOwner ? <Th>Owner</Th> : null}
              <Th>Created</Th>
              <Th>Last used</Th>
              <Th>Status</Th>
              <Th className="text-right">Actions</Th>
            </Tr>
          </THead>
          <TBody>
            {tokens.map((token) => (
              <Tr key={token.id}>
                <Td className="font-medium text-zinc-900">{token.name}</Td>
                <Td>
                  <span className="font-mono text-xs text-zinc-600">{token.tokenPrefix}…</span>
                </Td>
                {showOwner ? <Td className="text-zinc-600">{token.userEmail}</Td> : null}
                <Td className="whitespace-nowrap text-zinc-600">{formatDate(token.createdAt)}</Td>
                <Td className="whitespace-nowrap text-zinc-600">{formatDate(token.lastUsedAt)}</Td>
                <Td>{token.revokedAt ? <Badge tone="red">Revoked</Badge> : <Badge tone="green">Active</Badge>}</Td>
                <Td className="text-right">
                  {token.revokedAt ? null : (
                    <ActionForm
                      action={revokeApiTokenAction}
                      confirmMessage="Revoke this token? Agents using it will lose access immediately."
                    >
                      <input type="hidden" name="tokenId" value={token.id} />
                      <Button type="submit" variant="danger" size="sm">
                        Revoke
                      </Button>
                    </ActionForm>
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
