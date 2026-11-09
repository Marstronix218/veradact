import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { isDemoLoginEnabled, isSignupEnabled } from "@veradact/core";
import { ActionForm, AuthSwitch, Button, Card, Input, Notice, Wordmark } from "@/components";
import { getAuth } from "@/lib/session";
import { requestLoginLink, signInToDemo } from "./actions";

export const metadata: Metadata = { title: "Sign in" };

const ERRORS: Record<string, string> = {
  link: "That sign-in link is invalid, has expired or was already used. Request a new one below.",
  exists: "That email address already has an account. Sign in below.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
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
      {isSignupEnabled() ? <AuthSwitch current="login" /> : null}
      <Card title="Sign in" description="We'll email you a one-time sign-in link. There is no password.">
        {errorMessage ? (
          <div className="mb-4">
            <Notice tone="error">{errorMessage}</Notice>
          </div>
        ) : null}
        <ActionForm action={requestLoginLink} className="space-y-4">
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
            Email me a sign-in link
          </Button>
        </ActionForm>
      </Card>
      {isDemoLoginEnabled() ? (
        <Card title="Demo account" description="Fictional Quillfield Labs data. Works for the seeded demo users only." className="mt-6">
          <ActionForm action={signInToDemo} className="space-y-4">
            {/* The seed's default admin (packages/seed/src/demo.ts); tomas@quillfield.example is the member. */}
            <Input id="demo-email" name="email" type="email" label="Demo email" autoComplete="username" required maxLength={254} defaultValue="admin@quillfield.example" />
            <Input id="demo-password" name="password" type="password" label="Password" autoComplete="current-password" required maxLength={256} />
            <Button type="submit" variant="secondary" className="w-full">
              Sign in to the demo
            </Button>
          </ActionForm>
        </Card>
      ) : null}
    </main>
  );
}
