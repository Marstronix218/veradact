// Server-action plumbing: run the work, turn core's coded errors into form messages.
import { unstable_rethrow } from "next/navigation";
import { isCoreError, logError } from "@veradact/core";
import type { FormState } from "./form-state";

/**
 * Runs `fn` and returns `{ status: "ok", message }` with the string it returns, or
 * `{ status: "error", message }` for a core `CoreError` (fixed, user-safe messages).
 * Redirects (e.g. from `requireAuth`) propagate; anything else is logged by class/SQLSTATE
 * only and shown as a generic failure.
 */
export async function runAction(fn: () => Promise<string | undefined | void>): Promise<FormState> {
  try {
    const message = await fn();
    return message ? { status: "ok", message } : { status: "ok" };
  } catch (error) {
    unstable_rethrow(error);
    if (isCoreError(error)) return { status: "error", message: error.message };
    logError("web.action_failed", error);
    return { status: "error", message: "Something went wrong. Please try again." };
  }
}
