import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ActionForm, Button, Card, Input, Notice } from "@/components";
import { getAuth } from "@/lib/session";
import { requestLoginLink } from "./actions";

export const metadata: Metadata = { title: "Sign in" };

const ERRORS: Record<string, string> = {
  link: "That sign-in link is invalid, has expired or was already used. Request a new one below.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await getAuth()) redirect("/engagements");
  const { error } = await searchParams;
  const errorMessage = error ? ERRORS[error] : undefined;

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4 py-12">
      <p className="mb-6 text-center text-lg font-semibold tracking-tight">Veradact</p>
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
    </main>
  );
}
