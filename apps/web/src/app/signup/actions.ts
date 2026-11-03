"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { completeSignup, RateLimitedError, requestSignup, ValidationError } from "@veradact/core";
import { runAction } from "@/lib/actions";
import { clock } from "@/lib/clock";
import { getDb } from "@/lib/db";
import { getEmailProvider } from "@/lib/email";
import { appUrl } from "@/lib/env";
import type { FormState } from "@/lib/form-state";
import { requestInfo } from "@/lib/request";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/session";

const CHECK_EMAIL =
  "Check your email. We've sent a link to finish creating your account. It expires in 30 minutes.";

/**
 * Answers "check your email" for every well-formed address, whether or not it already has an
 * account and whether or not a rate limit was hit (no user enumeration). Delivery runs after
 * the response.
 */
export async function requestSignupLink(_prev: FormState, formData: FormData): Promise<FormState> {
  return runAction(async () => {
    const { ip } = await requestInfo();
    const result = await requestSignup({
      db: getDb(),
      email: String(formData.get("email") ?? ""),
      clock,
      emailProvider: getEmailProvider(),
      appUrl: appUrl(),
      ip,
      defer: (task) => after(task),
    });
    if (result.status === "disabled") redirect("/signup");
    if (result.status === "invalid_email") throw new ValidationError("Enter a valid email address.", "email");
    return CHECK_EMAIL;
  });
}

/** Creates the org and its admin from the sign-up link, sets the session cookie, opens the app. */
export async function finishSignup(_prev: FormState, formData: FormData): Promise<FormState> {
  return runAction(async () => {
    const { ip } = await requestInfo();
    const token = formData.get("token");
    const result = await completeSignup({
      db: getDb(),
      token: typeof token === "string" ? token : null,
      orgName: String(formData.get("orgName") ?? ""),
      userName: String(formData.get("userName") ?? ""),
      clock,
      ip,
    });
    switch (result.status) {
      case "disabled":
        redirect("/signup");
      case "invalid":
        redirect("/signup?error=link");
      case "exists":
        redirect("/login?error=exists");
      case "rate_limited":
        throw new RateLimitedError(result.retryAfterSeconds, "Too many attempts. Try again in a few minutes.");
      case "ok":
        (await cookies()).set(SESSION_COOKIE, result.sessionToken, sessionCookieOptions(result.expiresAt));
        redirect("/engagements");
    }
  });
}
