// The sign-up link (D-062). GET only checks the sealed token (no database, nothing consumed) and
// renders the form, so mail scanners that prefetch the link create nothing. Submitting the form
// creates the org and its admin.
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import {
  isSignupEnabled,
  openSignupToken,
  ORG_NAME_MAX_LENGTH,
  SIGNUP_USER_NAME_MAX_LENGTH,
} from "@veradact/core";
import { ActionForm, Button, Card, Input } from "@/components";
import { clock } from "@/lib/clock";
import { getAuth } from "@/lib/session";
import { finishSignup } from "../actions";

export const metadata: Metadata = { title: "Finish creating your account", referrer: "strict-origin" };

const MAX_TOKEN_LENGTH = 1500;

export default async function SignupCompletePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  if (!isSignupEnabled()) redirect("/signup");
  if (await getAuth()) redirect("/engagements");
  const { token } = await searchParams;
  const email =
    typeof token === "string" && token.length <= MAX_TOKEN_LENGTH ? openSignupToken({ token, now: clock() }) : null;
  if (!token || !email) redirect("/signup?error=link");

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4 py-12">
      <p className="mb-6 text-center text-lg font-semibold tracking-tight">Veradact</p>
      <Card title="Finish creating your account" description={`You'll be the admin of the new organization as ${email}.`}>
        <ActionForm action={finishSignup} className="space-y-4" preserveValues>
          <input type="hidden" name="token" value={token} />
          <Input
            name="orgName"
            label="Organization name"
            autoComplete="organization"
            required
            maxLength={ORG_NAME_MAX_LENGTH}
            placeholder="Acme Studio"
          />
          <Input
            name="userName"
            label="Your name"
            autoComplete="name"
            required
            maxLength={SIGNUP_USER_NAME_MAX_LENGTH}
          />
          <Button type="submit" className="w-full">
            Create account
          </Button>
        </ActionForm>
      </Card>
    </main>
  );
}
