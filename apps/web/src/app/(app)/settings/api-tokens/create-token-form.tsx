"use client";

import { useActionState, useState } from "react";
import { Button, Input, Notice } from "@/components";
import { createApiTokenAction, type CreateTokenState } from "./actions";

/** Creates a token and shows the raw value exactly once, with MCP connection details. */
export function CreateTokenForm({ mcpUrl }: { mcpUrl: string }) {
  const [state, formAction, pending] = useActionState<CreateTokenState, FormData>(createApiTokenAction, {
    status: "idle",
  });
  const [copied, setCopied] = useState(false);

  async function copy(token: string) {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="space-y-4">
      {state.status === "error" && state.message ? <Notice tone="error">{state.message}</Notice> : null}
      {state.token ? (
        <div className="space-y-3 rounded-md border border-green-200 bg-green-50 p-4" data-testid="new-api-token">
          <p className="text-sm font-medium text-green-900">
            Token “{state.name}” created. Copy it now: it won&apos;t be shown again.
          </p>
          <div className="flex gap-2">
            <input
              readOnly
              aria-label="New API token"
              value={state.token}
              onFocus={(e) => e.currentTarget.select()}
              className="block w-full rounded-md border border-green-300 bg-white px-3 py-2 font-mono text-xs text-zinc-900"
            />
            <Button type="button" variant="secondary" onClick={() => copy(state.token!)}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <div className="space-y-1 text-sm text-green-900">
            <p>
              MCP server URL: <code className="font-mono text-xs">{mcpUrl}</code>
            </p>
            <p>Send the token as a bearer token, for example in Claude Code:</p>
            <pre className="overflow-x-auto rounded bg-white p-2 font-mono text-xs text-zinc-800">
              {`claude mcp add --transport http veradact ${mcpUrl} --header "Authorization: Bearer <token>"`}
            </pre>
          </div>
        </div>
      ) : null}
      <form action={formAction} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="sm:w-80">
          <Input name="name" label="Token name" placeholder="e.g. Claude Code on my laptop" required maxLength={100} />
        </div>
        <Button type="submit" disabled={pending}>
          Create token
        </Button>
      </form>
    </div>
  );
}
