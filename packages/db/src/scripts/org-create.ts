// Operator script (D-030): creates an org and its first admin user with the admin URL.
//
//   pnpm org:create --name "Quillfield Labs" --slug quillfield \
//     --admin-email admin@quillfield.example --admin-name "Ada Admin"
//
// Prints the new org id. Never echoes names or emails (CLAUDE.md logging rule).
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { createDb } from "../client";
import { loadRootEnv, requireEnv } from "../env";
import { getPgError } from "../errors";
import { appUser, org } from "../schema";

const USAGE =
  'usage: pnpm org:create --name "<org name>" --slug <slug> --admin-email <email> --admin-name "<name>"';

function fail(message: string): never {
  console.error(`org:create: ${message}\n${USAGE}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      name: { type: "string" },
      slug: { type: "string" },
      "admin-email": { type: "string" },
      "admin-name": { type: "string" },
    },
  });
  const name = values.name?.trim();
  const slug = values.slug?.trim();
  const adminEmail = values["admin-email"]?.trim();
  const adminName = values["admin-name"]?.trim();
  if (!name || !slug || !adminEmail || !adminName) fail("all four options are required");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(slug)) {
    fail("slug must be 1-40 chars of a-z, 0-9 and inner hyphens");
  }
  if (!/^[^\s@]+@[^\s@]+$/.test(adminEmail)) fail("admin email is not valid");

  loadRootEnv();
  const { db, close } = createDb(requireEnv("DATABASE_ADMIN_URL"), { max: 1 });
  try {
    const orgId = randomUUID();
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.insert(org).values({ id: orgId, name, slug, createdAt: now });
      await tx.insert(appUser).values({
        orgId,
        email: adminEmail,
        name: adminName,
        role: "admin",
        createdAt: now,
      });
    });
    console.log(orgId);
  } catch (error) {
    // 23505: unique violation (slug, or an email already registered to a user).
    const pg = getPgError(error);
    if (pg?.code === "23505") fail(`already exists (${pg.constraint ?? "unique constraint"})`);
    throw error;
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  // Drizzle's error message embeds query parameters (names, emails): report SQLSTATE only.
  const pg = getPgError(error);
  console.error("org:create failed:", pg ? `SQLSTATE ${pg.code} ${pg.constraint ?? ""}`.trim() : error);
  process.exit(1);
});
