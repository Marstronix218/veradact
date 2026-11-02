"use server";

import { after } from "next/server";
import { requestMagicLink, ValidationError } from "@veradact/core";
import { runAction } from "@/lib/actions";
import { clock } from "@/lib/clock";
import { getDb } from "@/lib/db";
import { getEmailProvider } from "@/lib/email";
import { appUrl } from "@/lib/env";
import type { FormState } from "@/lib/form-state";
import { requestInfo } from "@/lib/request";

const CHECK_EMAIL =
  "Check your email. If that address belongs to a Veradact account, we've sent a sign-in link. It works once and expires in 15 minutes.";

/**
 * Answers "check your email" for every well-formed address, whether or not it has an
 * account and whether or not a rate limit was hit (no user enumeration). Delivery runs
 * after the response, so its latency reveals nothing either.
 */
export async function requestLoginLink(_prev: FormState, formData: FormData): Promise<FormState> {
  return runAction(async () => {
    const { ip } = await requestInfo();
    const result = await requestMagicLink({
      db: getDb(),
      email: String(formData.get("email") ?? ""),
      clock,
      emailProvider: getEmailProvider(),
      appUrl: appUrl(),
      ip,
      defer: (task) => after(task),
    });
    if (result.status === "invalid_email") throw new ValidationError("Enter a valid email address.", "email");
    return CHECK_EMAIL;
  });
}
