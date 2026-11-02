// Audit coverage (ARCHITECTURE §14): every action in AUDIT_ACTIONS is written by a real code path,
// and audit metadata carries ids, enums, counts and booleans only — never the names, emails,
// statements or text that the audited actions handle. Core actions are exercised here through the
// functions the web app calls; the export actions are written by the web app's export downloads
// (apps/web/src/lib/export-download.ts, tested in export-download.int.test.ts), so for those this
// file checks that a non-test source file writes them.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { appUser, auditLog, withTenant } from "@veradact/db";
import { adminTestDb, testDb } from "@veradact/db/testing";
import { MemoryEmailProvider } from "@veradact/email";
import { createApiToken, revokeApiToken } from "./api-tokens";
import { AUDIT_ACTIONS, type AuditAction } from "./audit";
import { requestMagicLink, verifyMagicLink } from "./auth/magic-link";
import { logout } from "./auth/session";
import {
  addContact,
  archiveEngagement,
  createItem,
  eraseContact,
  reactivateEngagement,
  redactSource,
  revokeConfirmation,
  setClientEmailDomains,
  updateEngagement,
} from "./commands";
import { EmailLinkChannel, sendConfirmationRequest } from "./confirmation";
import { setEngagementAiEnabled } from "./extraction";
import { deactivateUser, inviteUser, updateOrgSettings } from "./org";
import { createLedgerEngagement, NOTES_TEXT } from "./test-support/ledger";

const app = testDb();
const admin = adminTestDb();

afterAll(async () => {
  await Promise.all([app.close(), admin.close()]);
});

const APP_URL = "http://veradact.test";
const clock = () => new Date();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Actions written outside core, with the module that writes them. */
const WRITTEN_OUTSIDE_CORE: Partial<Record<AuditAction, string>> = {
  "export.spec": "apps/web/src/lib/export-download.ts",
  "export.record_md": "apps/web/src/lib/export-download.ts",
  "export.record_pdf": "apps/web/src/lib/export-download.ts",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENUM_TOKEN = /^[a-z0-9][a-z0-9_.:-]{0,63}$/i;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === "node_modules" || name === ".next") return [];
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

describe("audit coverage", () => {
  it("every action outside core is written by a non-test source file", () => {
    for (const [action, file] of Object.entries(WRITTEN_OUTSIDE_CORE)) {
      expect(readFileSync(path.join(repoRoot, file), "utf8"), action).toContain(`"${action}"`);
    }
    // And nothing in AUDIT_ACTIONS is dead: each appears in some source file other than audit.ts.
    const sources = ["packages", "apps"].flatMap((top) =>
      readdirSync(path.join(repoRoot, top)).flatMap((pkg) => {
        const src = path.join(repoRoot, top, pkg, "src");
        try {
          return sourceFiles(src);
        } catch {
          return [];
        }
      }),
    );
    const text = sources.filter((f) => !f.endsWith(path.join("core", "src", "audit.ts"))).map((f) => readFileSync(f, "utf8")).join("\n");
    for (const action of AUDIT_ACTIONS) expect(text, action).toContain(`"${action}"`);
  });

  it("writes every core action through the real code paths, with ids-only metadata", async () => {
    // PII and text the audited actions handle; none of it may appear in any audit row.
    const contactName = `Ada Lovelace-${randomUUID().slice(0, 6)}`;
    const contactEmail = `ada.${randomUUID().slice(0, 6)}@client.example`;
    const outsideEmail = `mallory.${randomUUID().slice(0, 6)}@vendor.example`;
    const inviteEmail = `new.member.${randomUUID().slice(0, 6)}@quillfield.example`;
    const inviteName = `Nadia Newcomer ${randomUUID().slice(0, 6)}`;
    const statement = "The dispatch dashboard refreshes every five minutes.";
    const tokenName = `Coding agent ${randomUUID().slice(0, 6)}`;
    const secrets: string[] = [contactName, contactEmail, outsideEmail, inviteEmail, inviteName, statement, tokenName, "client.example", "Renamed engagement"];

    // engagement.create + source.ingest (createLedgerEngagement goes through createEngagement and ingestSource).
    const e = await createLedgerEngagement(app, admin.db, new Date());
    const ctx = { ...e.ctx, clock };
    const auth = { orgId: e.orgId, userId: e.userId, role: "admin" as const };
    secrets.push(...NOTES_TEXT.split("\n").filter((line) => line.length > 20));

    // auth.login + auth.logout
    const mail = new MemoryEmailProvider();
    const [{ email: userEmail } = { email: "" }] = await admin.db.select({ email: appUser.email }).from(appUser).where(eq(appUser.id, e.userId));
    secrets.push(userEmail);
    await requestMagicLink({ db: app.db, email: userEmail, clock, emailProvider: mail, appUrl: APP_URL, ip: `audit-${randomUUID()}` });
    const loginToken = /token=([A-Za-z0-9_-]+)/.exec(mail.lastTo(userEmail)!.text)![1]!;
    secrets.push(loginToken);
    const login = await verifyMagicLink({ db: app.db, token: loginToken, clock, ip: `audit-${randomUUID()}` });
    if (login.status !== "ok") throw new Error("login failed");
    secrets.push(login.sessionToken);
    expect(await logout({ db: app.db, token: login.sessionToken, clock })).toBe(true);

    // engagement.update (fields, status, client email domains) + ai.toggle (engagement and org) + settings.update
    await updateEngagement(ctx, { engagementId: e.engagementId, name: "Renamed engagement" });
    await archiveEngagement(ctx, { engagementId: e.engagementId });
    await reactivateEngagement(ctx, { engagementId: e.engagementId });
    await setClientEmailDomains(ctx, { engagementId: e.engagementId, domains: "client.example" });
    await setEngagementAiEnabled(ctx, { engagementId: e.engagementId, enabled: false });
    await updateOrgSettings({ db: app.db, ctx: auth, clock, patch: { aiEnabled: false } });
    await updateOrgSettings({ db: app.db, ctx: auth, clock, patch: { retentionDays: 90, reminderBusinessDays: 3 } });

    // contact.outside_domains, confirmation.request, confirmation.revoke, contact.erase
    const item = await createItem(ctx, { engagementId: e.engagementId, kind: "requirement", statement, manual: true });
    const { contactId } = await addContact(ctx, { engagementId: e.engagementId, name: contactName, email: contactEmail });
    await addContact(ctx, { engagementId: e.engagementId, name: "Mallory Outside", email: outsideEmail, acknowledgeOutsideDomains: true });
    const sent = await sendConfirmationRequest(ctx, {
      engagementId: e.engagementId,
      items: [{ itemId: item.itemId }],
      contactIds: [contactId],
      appUrl: APP_URL,
      channel: new EmailLinkChannel(new MemoryEmailProvider()),
    });
    await revokeConfirmation(ctx, { engagementId: e.engagementId, requestId: sent.requestId });
    await eraseContact(ctx, { engagementId: e.engagementId, contactId });

    // source.redact
    await redactSource(ctx, { engagementId: e.engagementId, sourceId: e.sourceId, reasonCode: "user_request", note: "Client asked us to remove the kickoff notes" });
    secrets.push("Client asked us to remove the kickoff notes");

    // user.invite + user.deactivate + api_token.create + api_token.revoke
    const invited = await inviteUser({ db: app.db, ctx: auth, clock, emailProvider: new MemoryEmailProvider(), appUrl: APP_URL, email: inviteEmail, name: inviteName, role: "member" });
    const token = await createApiToken({ db: app.db, ctx: auth, clock, name: tokenName });
    secrets.push(token.token);
    await revokeApiToken({ db: app.db, ctx: auth, clock, tokenId: token.id });
    await deactivateUser({ db: app.db, ctx: auth, clock, userId: invited.user.id });

    const rows = await withTenant(app.db, { orgId: e.orgId }, (tx) => tx.select().from(auditLog).where(eq(auditLog.orgId, e.orgId)));
    const written = new Set(rows.map((r) => r.action));
    const coreActions = AUDIT_ACTIONS.filter((a) => !(a in WRITTEN_OUTSIDE_CORE));
    for (const action of coreActions) expect(written.has(action), action).toBe(true);
    expect([...written].filter((a) => !(AUDIT_ACTIONS as readonly string[]).includes(a))).toEqual([]);

    for (const row of rows) {
      expect(row.actorUserId === null || UUID.test(row.actorUserId), row.action).toBe(true);
      expect(row.targetId === null || UUID.test(row.targetId), row.action).toBe(true);
      for (const [key, value] of Object.entries(row.metadata as Record<string, unknown>)) {
        const safe =
          value === null ||
          typeof value === "boolean" ||
          typeof value === "number" ||
          (typeof value === "string" && (UUID.test(value) || (ENUM_TOKEN.test(value) && !value.includes("@"))));
        expect(safe, `${row.action}.${key}`).toBe(true);
      }
      const serialized = JSON.stringify(row);
      for (const secret of secrets) expect(serialized, `${row.action} leaks a value`).not.toContain(secret);
    }
  });
});
