// Self-serve sign-up (D-062): email → 30-minute sign-up link → org name and your name → a new org
// (AI off) with you as its admin, and a session.
//
// Nothing is stored before the account exists. The link carries the email sealed with
// AES-256-GCM under a key derived from LINK_SIGNING_SECRET, so the URL shows no address and
// cannot be forged. A link stays usable until its account exists; after that the email is taken
// and the link only leads to "sign in instead".
//
// No user enumeration: every well-formed address gets the same answer. The lookup and the email
// (a sign-up link, or a note that the address already has an account) run in one task; pass
// `defer` (Next's `after`) so that task runs after the response.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { authFindUserByEmail, signupCreateOrg, withTenant, type Db } from "@veradact/db";
import type { EmailProvider } from "@veradact/email";
import { writeAudit } from "../audit";
import { linkSigningSecret } from "../confirmation/link-token";
import { ValidationError } from "../errors";
import { log, logError, logId } from "../log";
import { checkRateLimit } from "../security/rate-limit";
import { normalizeEmail } from "./email-address";
import { createSession, type VerifiedLogin } from "./session";

export const SIGNUP_TOKEN_TTL_MS = 30 * 60 * 1000;
export const ORG_NAME_MAX_LENGTH = 200;
export const SIGNUP_USER_NAME_MAX_LENGTH = 200;

/** Fixed windows for sign-up (ARCHITECTURE §14). */
export const SIGNUP_RATE_LIMITS = {
  perIp: { limit: 10, windowSeconds: 60 * 60 },
  perEmail: { limit: 3, windowSeconds: 60 * 60 },
  completePerIp: { limit: 30, windowSeconds: 15 * 60 },
} as const;

type Env = Record<string, string | undefined>;

/** Sign-up is open only when `SIGNUP_ENABLED=true`. */
export function isSignupEnabled(env: Env = process.env): boolean {
  return env.SIGNUP_ENABLED?.trim().toLowerCase() === "true";
}

const TOKEN_PATTERN = /^v1\.([A-Za-z0-9_-]{40,1400})$/;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const AAD = Buffer.from("veradact signup v1", "utf8");

/** A key used only for sign-up tokens: HKDF separates it from the link-signing HMAC key. */
function signupKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "", "veradact signup token v1", 32));
}

/** `v1.<base64url(iv | ciphertext | tag)>` over `{"e":email,"x":exp seconds}`. */
export function sealSignupToken(input: { secret: string; email: string; expiresAt: Date }): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", signupKey(input.secret), iv);
  cipher.setAAD(AAD);
  const plaintext = JSON.stringify({ e: input.email, x: Math.floor(input.expiresAt.getTime() / 1000) });
  const sealed = Buffer.concat([iv, cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `v1.${sealed.toString("base64url")}`;
}

/**
 * The normalized email of an authentic, unexpired token; null for anything else. No database:
 * safe to call when rendering the link's page. `secret` defaults to `LINK_SIGNING_SECRET`.
 */
export function openSignupToken(input: { secret?: string; token: string; now: Date }): string | null {
  const match = TOKEN_PATTERN.exec(input.token);
  if (!match) return null;
  const sealed = Buffer.from(match[1]!, "base64url");
  if (sealed.length <= IV_BYTES + TAG_BYTES) return null;
  const key = signupKey(input.secret ?? linkSigningSecret());
  let payload: unknown;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, IV_BYTES));
    decipher.setAAD(AAD);
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    const plaintext = Buffer.concat([
      decipher.update(sealed.subarray(IV_BYTES, sealed.length - TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
    payload = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const { e, x } = payload as { e?: unknown; x?: unknown };
  if (typeof e !== "string" || typeof x !== "number" || !Number.isSafeInteger(x)) return null;
  if (x * 1000 <= input.now.getTime()) return null;
  return normalizeEmail(e) === e ? e : null;
}

/** `${appUrl}/signup/complete?token=…`. */
export function signupUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/+$/, "")}/signup/complete?token=${encodeURIComponent(token)}`;
}

/** Lower-case a-z0-9 words of the org name plus a random suffix: at most 37 characters. */
export function orgSlug(orgName: string, suffix = randomBytes(3).toString("hex")): string {
  const base = orgName
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 30)
    .replace(/-+$/, "");
  return `${base || "org"}-${suffix}`;
}

export interface RequestSignupInput {
  db: Db;
  email: string;
  clock: () => Date;
  emailProvider: EmailProvider;
  /** Public base URL of the web app, e.g. `https://app.example.com`. */
  appUrl: string;
  /** Client IP for the per-IP limit (hashed; never stored raw). */
  ip: string;
  /** Schedules delivery after the response (e.g. `next/server` `after`). Default: awaited. */
  defer?: (task: () => Promise<void>) => void;
  /** Defaults to `LINK_SIGNING_SECRET`. */
  secret?: string;
  /** Defaults to `process.env` (for `SIGNUP_ENABLED`). */
  env?: Env;
}

export type RequestSignupResult =
  | { status: "accepted" }
  | { status: "disabled" }
  | { status: "invalid_email" }
  | { status: "rate_limited"; retryAfterSeconds: number };

export async function requestSignup(input: RequestSignupInput): Promise<RequestSignupResult> {
  const { db, clock, emailProvider, appUrl, ip, defer } = input;
  if (!isSignupEnabled(input.env)) return { status: "disabled" };
  const secret = input.secret ?? linkSigningSecret();
  const now = clock();

  const byIp = await checkRateLimit(db, { scope: "signup_ip", id: ip, now, ...SIGNUP_RATE_LIMITS.perIp });
  if (!byIp.allowed) return { status: "rate_limited", retryAfterSeconds: byIp.retryAfterSeconds };

  const email = normalizeEmail(input.email);
  if (!email) return { status: "invalid_email" };

  const byEmail = await checkRateLimit(db, { scope: "signup_email", id: email, now, ...SIGNUP_RATE_LIMITS.perEmail });
  if (!byEmail.allowed) return { status: "rate_limited", retryAfterSeconds: byEmail.retryAfterSeconds };

  const send = async (): Promise<void> => {
    try {
      const existing = await authFindUserByEmail(db, email);
      if (existing) {
        await emailProvider.send({
          to: email,
          subject: "You already have a Veradact account",
          text:
            "Someone asked to create a Veradact account with this address, but it already has one.\n\n" +
            `Sign in here: ${appUrl.replace(/\/+$/, "")}/login\n\n` +
            "If this was not you, you can ignore this email.\n",
          tags: { kind: "signup_existing" },
        });
        return;
      }
      const token = sealSignupToken({ secret, email, expiresAt: new Date(now.getTime() + SIGNUP_TOKEN_TTL_MS) });
      await emailProvider.send({
        to: email,
        subject: "Finish creating your Veradact account",
        text:
          "Use this link to finish creating your Veradact account. It expires in 30 minutes.\n\n" +
          `${signupUrl(appUrl, token)}\n\n` +
          "If you did not ask for an account, you can ignore this email.\n",
        tags: { kind: "signup" },
      });
      log.info("auth.signup.link_sent", {});
    } catch (error) {
      logError("auth.signup.delivery_failed", error);
    }
  };
  if (defer) defer(send);
  else await send();
  return { status: "accepted" };
}

export interface CompleteSignupInput {
  db: Db;
  token: string | null | undefined;
  orgName: string;
  userName: string;
  clock: () => Date;
  /** Client IP for the per-IP limit (hashed; never stored raw). */
  ip: string;
  /** Defaults to `LINK_SIGNING_SECRET`. */
  secret?: string;
  /** Defaults to `process.env` (for `SIGNUP_ENABLED`). */
  env?: Env;
}

export type CompleteSignupResult =
  | ({ status: "ok" } & VerifiedLogin)
  | { status: "disabled" }
  | { status: "invalid" }
  | { status: "exists" }
  | { status: "rate_limited"; retryAfterSeconds: number };

/**
 * Opens the sign-up token, creates the org (AI off) and its admin through `signup_create_org`,
 * then opens a session, auditing `auth.signup` and `auth.login`. A bad or expired token is
 * `invalid`; an email that already has an account is `exists`. Names that are empty or too long
 * throw `ValidationError`.
 */
export async function completeSignup(input: CompleteSignupInput): Promise<CompleteSignupResult> {
  const { db, token, clock, ip } = input;
  if (!isSignupEnabled(input.env)) return { status: "disabled" };
  const now = clock();

  const limit = await checkRateLimit(db, {
    scope: "signup_complete_ip",
    id: ip,
    now,
    ...SIGNUP_RATE_LIMITS.completePerIp,
  });
  if (!limit.allowed) return { status: "rate_limited", retryAfterSeconds: limit.retryAfterSeconds };

  const email = token ? openSignupToken({ secret: input.secret, token, now }) : null;
  if (!email) return { status: "invalid" };

  const orgName = input.orgName.trim();
  if (orgName.length === 0 || orgName.length > ORG_NAME_MAX_LENGTH) {
    throw new ValidationError(`Organization name must be 1 to ${ORG_NAME_MAX_LENGTH} characters.`, "orgName");
  }
  const userName = input.userName.trim();
  if (userName.length === 0 || userName.length > SIGNUP_USER_NAME_MAX_LENGTH) {
    throw new ValidationError(`Name must be 1 to ${SIGNUP_USER_NAME_MAX_LENGTH} characters.`, "userName");
  }

  const created = await signupCreateOrg(db, {
    orgId: randomUUID(),
    orgName,
    slug: orgSlug(orgName),
    userId: randomUUID(),
    email,
    userName,
    createdAt: now,
  });
  if (!created) {
    log.info("auth.signup.exists", {});
    return { status: "exists" };
  }

  return withTenant(db, created, async (tx) => {
    const session = await createSession(tx, { orgId: created.orgId, userId: created.userId, now });
    await writeAudit(tx, {
      orgId: created.orgId,
      actorUserId: created.userId,
      action: "auth.signup",
      targetType: "org",
      targetId: created.orgId,
      at: now,
    });
    await writeAudit(tx, {
      orgId: created.orgId,
      actorUserId: created.userId,
      action: "auth.login",
      targetType: "session",
      targetId: session.sessionId,
      metadata: { method: "signup" },
      at: now,
    });
    log.info("auth.signup.completed", { orgId: logId(created.orgId), userId: logId(created.userId) });
    return {
      status: "ok",
      sessionToken: session.token,
      expiresAt: session.expiresAt,
      session: {
        sessionId: session.sessionId,
        orgId: created.orgId,
        userId: created.userId,
        role: "admin",
        expiresAt: session.expiresAt,
      },
      user: { id: created.userId, email, name: userName, role: "admin" },
    } as const;
  });
}
