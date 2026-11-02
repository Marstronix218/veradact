export { isAdmin, requireAdmin, type AuthContext, type UserRole } from "./context";
export { normalizeEmail } from "./email-address";
export {
  LOGIN_TOKEN_TTL_MS,
  MAGIC_LINK_RATE_LIMITS,
  requestMagicLink,
  verifyMagicLink,
  type RequestMagicLinkInput,
  type RequestMagicLinkResult,
  type VerifiedLogin,
  type VerifyMagicLinkResult,
} from "./magic-link";
export {
  createSession,
  logout,
  resolveSession,
  SESSION_TOUCH_INTERVAL_MS,
  SESSION_TTL_MS,
  type NewSession,
  type SessionAuth,
} from "./session";
