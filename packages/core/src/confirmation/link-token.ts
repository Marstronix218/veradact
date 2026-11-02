// Client confirmation links (ARCHITECTURE §8.2, D-018): `v1.<link_id>.<exp_unix>.<sig>` with
// `sig = base64url(HMAC-SHA256(LINK_SIGNING_SECRET, "v1|link_id|contact_id|exp"))`. The signature
// binds the link to its contact and expiry; the `confirmation_link` row adds revocation and open
// tracking. Tokens are never stored or logged — a reminder re-signs the same link.
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  clientContact,
  confirmationRequest,
  confirmationRequestContact,
  contactPii,
  linkResolve,
  withTenant,
  type Db,
} from "@veradact/db";
import { isWeakSecret } from "../security/secrets";

const TOKEN_PATTERN = /^v1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/;
const MIN_SECRET_LENGTH = 32;
/** Compared against when the link id is unknown, so that path costs one HMAC like the others. */
const DUMMY_CONTACT_ID = "00000000-0000-4000-8000-000000000000";

/**
 * `LINK_SIGNING_SECRET` (≥ 32 characters; in production never a `.env.example` placeholder).
 * Rotating it invalidates every outstanding link.
 */
export function linkSigningSecret(env: Record<string, string | undefined> = process.env): string {
  const secret = env.LINK_SIGNING_SECRET?.trim();
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`LINK_SIGNING_SECRET must be set to at least ${MIN_SECRET_LENGTH} characters (see .env.example)`);
  }
  if (env.NODE_ENV === "production" && isWeakSecret(secret)) {
    throw new Error("LINK_SIGNING_SECRET is a development placeholder; set a random value in production");
  }
  return secret;
}

function signature(secret: string, linkId: string, contactId: string, exp: number): string {
  return createHmac("sha256", secret).update(`v1|${linkId}|${contactId}|${exp}`, "utf8").digest("base64url");
}

export interface LinkTokenInput {
  secret: string;
  linkId: string;
  contactId: string;
  /** The link's `expires_at`; the token carries it in whole seconds. */
  expiresAt: Date;
}

export function signLinkToken(input: LinkTokenInput): string {
  const exp = Math.floor(input.expiresAt.getTime() / 1000);
  return `v1.${input.linkId}.${exp}.${signature(input.secret, input.linkId, input.contactId, exp)}`;
}

/** Syntax only (no signature check). Null for anything that is not a well-formed v1 token. */
export function parseLinkToken(token: string): { linkId: string; exp: number; sig: string } | null {
  const match = TOKEN_PATTERN.exec(token);
  if (!match) return null;
  return { linkId: match[1]!, exp: Number(match[2]), sig: match[3]! };
}

/** `${appUrl}/c/<token>`. */
export function clientLinkUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/+$/, "")}/c/${token}`;
}

/** What a valid link resolves to. Every client action runs in this tenant, request and contact. */
export interface ClientLinkContext {
  orgId: string;
  engagementId: string;
  requestId: string;
  contactId: string;
  linkId: string;
}

export type ResolveClientLinkResult = { ok: true; ctx: ClientLinkContext } | { ok: false };

const INVALID: ResolveClientLinkResult = { ok: false };

/**
 * Validates a client link token (§8.2): syntax → `link_resolve` → constant-time signature check
 * with the resolved contact id → `exp` and `expires_at` in the future → link not revoked → request
 * open for the contact in the projection (not revoked, not expired) → contact not erased. Every
 * failure is the same `{ ok: false }`, so callers render one "no longer valid" page.
 */
export async function resolveClientLink(input: {
  db: Db;
  token: string;
  clock: () => Date;
  /** Defaults to `LINK_SIGNING_SECRET`. */
  secret?: string;
}): Promise<ResolveClientLinkResult> {
  const secret = input.secret ?? linkSigningSecret();
  const parsed = parseLinkToken(input.token);
  if (!parsed) return INVALID;

  const link = await linkResolve(input.db, parsed.linkId);
  const expected = Buffer.from(signature(secret, parsed.linkId, link?.contactId ?? DUMMY_CONTACT_ID, parsed.exp));
  const given = Buffer.from(parsed.sig);
  const signatureOk = expected.length === given.length && timingSafeEqual(expected, given);
  if (!link || !signatureOk) return INVALID;

  const now = input.clock().getTime();
  if (parsed.exp * 1000 <= now || link.expiresAt.getTime() <= now || link.revokedAt !== null) return INVALID;

  const open = await withTenant(input.db, { orgId: link.orgId }, async (tx) => {
    const [row] = await tx
      .select({
        revokedAt: confirmationRequestContact.revokedAt,
        requestExpiresAt: confirmationRequest.expiresAt,
        erasedAt: clientContact.erasedAt,
        piiContactId: contactPii.contactId,
      })
      .from(confirmationRequestContact)
      .innerJoin(confirmationRequest, eq(confirmationRequest.id, confirmationRequestContact.requestId))
      .innerJoin(clientContact, eq(clientContact.id, confirmationRequestContact.contactId))
      .leftJoin(contactPii, eq(contactPii.contactId, confirmationRequestContact.contactId))
      .where(
        and(
          eq(confirmationRequestContact.requestId, link.requestId),
          eq(confirmationRequestContact.contactId, link.contactId),
          eq(confirmationRequestContact.engagementId, link.engagementId),
        ),
      );
    return (
      row !== undefined &&
      row.revokedAt === null &&
      row.requestExpiresAt.getTime() > now &&
      row.erasedAt === null &&
      row.piiContactId !== null
    );
  });
  if (!open) return INVALID;

  return {
    ok: true,
    ctx: { orgId: link.orgId, engagementId: link.engagementId, requestId: link.requestId, contactId: link.contactId, linkId: link.linkId },
  };
}
