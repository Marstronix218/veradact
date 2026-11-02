import type { Metadata } from "next";
import { isAdmin, listUsers } from "@veradact/core";
import { ActionForm, Badge, Button, Card, Input, Notice, Select, Table, TBody, Td, Th, THead, Tr } from "@/components";
import { getDb } from "@/lib/db";
import { requireAuth } from "@/lib/session";
import { deactivateUserAction, inviteUserAction } from "./actions";

export const metadata: Metadata = { title: "Users" };

const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });

export default async function UsersPage() {
  const auth = await requireAuth();
  const users = await listUsers(getDb(), auth);
  const canManage = isAdmin(auth);

  return (
    <div className="space-y-6">
      {canManage ? (
        <Card title="Add a user" description="They'll sign in with a one-time link sent to this address.">
          <ActionForm action={inviteUserAction} className="grid gap-4 sm:grid-cols-[1fr_1fr_10rem_auto] sm:items-end">
            <Input name="name" label="Name" required maxLength={200} autoComplete="off" />
            <Input name="email" type="email" label="Email" required maxLength={254} autoComplete="off" />
            <Select name="role" label="Role" defaultValue="member">
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </Select>
            <Button type="submit">Add user</Button>
          </ActionForm>
        </Card>
      ) : (
        <Notice>Only admins can add or deactivate users.</Notice>
      )}

      <Table>
        <THead>
          <Tr>
            <Th>Name</Th>
            <Th>Email</Th>
            <Th>Role</Th>
            <Th>Status</Th>
            <Th>Added</Th>
            {canManage ? <Th className="text-right">Actions</Th> : null}
          </Tr>
        </THead>
        <TBody>
          {users.map((user) => (
            <Tr key={user.id}>
              <Td className="font-medium text-zinc-900">
                {user.name}
                {user.id === auth.userId ? <span className="ml-2 text-xs font-normal text-zinc-500">(you)</span> : null}
              </Td>
              <Td className="text-zinc-600">{user.deactivatedAt ? "—" : user.email}</Td>
              <Td>
                <Badge tone={user.role === "admin" ? "blue" : "neutral"}>{user.role === "admin" ? "Admin" : "Member"}</Badge>
              </Td>
              <Td>
                {user.deactivatedAt ? <Badge>Deactivated</Badge> : <Badge tone="green">Active</Badge>}
              </Td>
              <Td className="whitespace-nowrap text-zinc-600">{dateFormat.format(user.createdAt)}</Td>
              {canManage ? (
                <Td className="text-right">
                  {user.deactivatedAt || user.id === auth.userId ? null : (
                    <ActionForm
                      action={deactivateUserAction}
                      confirmMessage="Deactivate this user? They will be signed out everywhere and their API tokens revoked."
                    >
                      <input type="hidden" name="userId" value={user.id} />
                      <Button type="submit" variant="danger" size="sm">
                        Deactivate
                      </Button>
                    </ActionForm>
                  )}
                </Td>
              ) : null}
            </Tr>
          ))}
        </TBody>
      </Table>
    </div>
  );
}
