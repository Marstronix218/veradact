// E2E fixtures written directly to the dev database with the owner role (DATABASE_ADMIN_URL).
// Test setup only (CLAUDE.md invariant 7). Every call creates fresh, uniquely named rows, so
// tests can run in parallel and repeatedly against the same database.
import { randomUUID } from "node:crypto";
import { appUser, createDb, org, rateLimitBucket, type DbHandle, type UserRole } from "@veradact/db";

let handle: DbHandle | undefined;

function adminDb() {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error("DATABASE_ADMIN_URL is not set (root .env)");
  handle ??= createDb(url, { max: 2 });
  return handle.db;
}

/** Close the pool in `test.afterAll`. */
export async function closeAdminDb(): Promise<void> {
  await handle?.close();
  handle = undefined;
}

export interface E2eUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

export interface E2eOrg {
  orgId: string;
  name: string;
  slug: string;
  admin: E2eUser;
}

const runId = () => randomUUID().slice(0, 8);

/** A fictional org with one admin user, unique per call. */
export async function createOrgWithAdmin(): Promise<E2eOrg> {
  const id = runId();
  const orgId = randomUUID();
  const name = `E2E Labs ${id}`;
  const slug = `e2e-${id}`;
  const admin: E2eUser = { id: randomUUID(), email: `e2e-admin-${id}@example.test`, name: "Erin Admin", role: "admin" };
  const now = new Date();
  await adminDb().transaction(async (tx) => {
    await tx.insert(org).values({ id: orgId, name, slug, createdAt: now });
    await tx.insert(appUser).values({ ...admin, orgId, createdAt: now });
  });
  return { orgId, name, slug, admin };
}

/** Another user in an existing org. */
export async function createUser(orgId: string, role: UserRole = "member"): Promise<E2eUser> {
  const user: E2eUser = { id: randomUUID(), email: `e2e-${role}-${runId()}@example.test`, name: "Morgan Member", role };
  await adminDb().insert(appUser).values({ ...user, orgId, createdAt: new Date() });
  return user;
}

/** Resets every rate-limit window (all e2e traffic comes from one local IP). Global setup only. */
export async function clearRateLimits(): Promise<void> {
  await adminDb().delete(rateLimitBucket);
}
