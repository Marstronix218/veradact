// Password sign-in for the seeded demo org (D-064), for local demos without opening a magic link.
// Off unless `DEMO_LOGIN_PASSWORD` is set (8+ characters), and always off in production. Only a
// user of the demo org (slug `DEMO_ORG_SLUG`, or `DEMO_LOGIN_ORG_SLUG`) whose address is under the
// reserved `.example` TLD (RFC 2606) can sign in: such an address cannot receive mail, and a
// `.example` user created in any other org (an invited placeholder) is not reachable.
import { createHash, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { authFindUserByEmail, org, withTenant, type Db } from "@veradact/db";
import { checkRateLimit } from "../security/rate-limit";
import { normalizeEmail } from "./email-address";
import { openSession, type VerifiedLogin } from "./session";

type Env = Record<string, string | undefined>;

/** The seed's demo org (packages/seed). Self-serve slugs always end in random hex, so cannot take it. */
export const DEMO_ORG_SLUG = "quillfield";

export const DEMO_PASSWORD_MIN_LENGTH = 8;

export const DEMO_LOGIN_RATE_LIMITS = {
  perIp: { limit: 10, windowSeconds: 15 * 60 },
} as const;

/** The configured demo password, or null when demo sign-in is off (unset, too short, or production). */
export function demoLoginPassword(env: Env = process.env): string | null {
  if (env.NODE_ENV === "production") return null;
  const value = env.DEMO_LOGIN_PASSWORD?.trim() ?? "";
  return value.length >= DEMO_PASSWORD_MIN_LENGTH ? value : null;
}

export function isDemoLoginEnabled(env: Env = process.env): boolean {
  return demoLoginPassword(env) !== null;
}

/** True for a single address whose domain is under the reserved `.example` TLD. */
export function isDemoAddress(email: string): boolean {
  const at = email.indexOf("@");
  return at > 0 && at === email.lastIndexOf("@") && email.slice(at + 1).endsWith(".example");
}

function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

export type DemoLoginResult =
  | ({ status: "ok" } & VerifiedLogin)
  | { status: "disabled" }
  | { status: "invalid" }
  | { status: "rate_limited"; retryAfterSeconds: number };

/**
 * Checks the shared demo password and opens a session for a demo-org user, auditing `auth.login`
 * (`method: demo_password`). A wrong password, a non-demo address, a user of another org and an
 * unknown or deactivated user are all `invalid`.
 */
export async function loginWithDemoPassword(input: {
  db: Db;
  email: string;
  password: string;
  clock: () => Date;
  /** Client IP for the per-IP limit (hashed; never stored raw). */
  ip: string;
  env?: Env;
}): Promise<DemoLoginResult> {
  const { db, clock, ip } = input;
  const env = input.env ?? process.env;
  const expected = demoLoginPassword(env);
  if (!expected) return { status: "disabled" };

  const now = clock();
  const limit = await checkRateLimit(db, { scope: "demo_login_ip", id: ip, now, ...DEMO_LOGIN_RATE_LIMITS.perIp });
  if (!limit.allowed) return { status: "rate_limited", retryAfterSeconds: limit.retryAfterSeconds };

  const email = normalizeEmail(input.email);
  if (!sameSecret(input.password, expected) || !email || !isDemoAddress(email)) return { status: "invalid" };
  const user = await authFindUserByEmail(db, email);
  if (!user) return { status: "invalid" };
  const [userOrg] = await withTenant(db, user, (tx) => tx.select({ slug: org.slug }).from(org).where(eq(org.id, user.orgId)));
  if (userOrg?.slug !== (env.DEMO_LOGIN_ORG_SLUG?.trim() || DEMO_ORG_SLUG)) return { status: "invalid" };
  return { status: "ok", ...(await openSession(db, user, now, "demo_password")) };
}
