import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { isSignupEnabled } from "@veradact/core";
import { ActionForm, AuthSwitch, Button, Card, Input, Notice, Wordmark } from "@/components";
import { getAuth } from "@/lib/session";
import { requestSignupLink } from "./actions";

export const metadata: Metadata = { title: "Create an account" };

const ERRORS: Record<string, string> = {
  link: "That sign-up link is invalid or has expired. Enter your email to get a new one.",
};

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await getAuth()) redirect("/engagements");
  const { error } = await searchParams;
  const errorMessage = error ? ERRORS[error] : undefined;

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4 py-12">
      <div className="mb-8 text-center">
        <Link href="/" className="inline-block rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ink-600">
          <Wordmark size="lg" />
        </Link>
        <p className="mt-2 text-sm text-zinc-600">Proof of what your client agreed to.</p>
      </div>
      <AuthSwitch current="signup" />
      {isSignupEnabled() ? (
        <Card
          title="Create an account"
          description="Start a new organization. We'll email you a link to confirm your address; there is no password."
        >
          {errorMessage ? (
            <div className="mb-4">
              <Notice tone="error">{errorMessage}</Notice>
            </div>
          ) : null}
          <ActionForm action={requestSignupLink} className="space-y-4">
            <Input
              name="email"
              type="email"
              label="Work email"
              autoComplete="email"
              required
              maxLength={254}
              placeholder="you@company.com"
            />
            <Button type="submit" className="w-full">
              Email me a sign-up link
            </Button>
          </ActionForm>
        </Card>
      ) : (
        <Card title="Sign-ups are closed" description="Ask your organization's admin to invite you." />
      )}
    </main>
  );
}
