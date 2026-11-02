# Veradact MCP server

A remote [MCP](https://modelcontextprotocol.io) server that gives coding agents (Claude Code, Cursor, any MCP client) read-only access to the client-confirmed spec of your engagements. Agents should build only confirmed items and cite their ids (`HALV-R7`) in commits and pull requests.

## Run locally

```bash
pnpm install
pnpm db:up && pnpm db:migrate && pnpm seed   # Postgres + demo org Quillfield Labs / engagement HALV
pnpm --filter @veradact/mcp dev               # or `pnpm dev` for web (:3000) + MCP (:3001)
curl http://localhost:3001/healthz            # {"ok":true}
```

The server reads the repo-root `.env` (`DATABASE_URL`, `MCP_PORT`, default 3001) and serves the MCP endpoint at `http://localhost:3001/mcp` (Streamable HTTP, stateless, JSON responses).

## Create an API token

In the web app go to **Settings → API tokens**, create a token and copy it. It starts with `vdt_` and is shown only once. A token acts as you, inside your organization, and can be revoked on the same page.

## Connect Claude Code

```bash
claude mcp add --transport http veradact http://localhost:3001/mcp \
  --header "Authorization: Bearer vdt_..."
```

Check it with `claude mcp list` or `/mcp` inside Claude Code.

## Connect Cursor

`.cursor/mcp.json` in the project (or `~/.cursor/mcp.json` for every project):

```json
{
  "mcpServers": {
    "veradact": {
      "url": "http://localhost:3001/mcp",
      "headers": { "Authorization": "Bearer vdt_..." }
    }
  }
}
```

Keep the token out of version control: use the global file, or `"Authorization": "Bearer ${env:VERADACT_TOKEN}"` with the variable set in your shell.

## Tools

| tool | input | returns |
|---|---|---|
| `list_engagements` | — | engagements of your org: id, short code, name, client, status, confirmed / not confirmed item counts, log head seq |
| `get_confirmed_spec` | `engagement_id` (UUID or short code `HALV`), `as_of?` (`YYYY-MM-DD` = end of that day in the engagement's time zone, or ISO 8601 timestamp with offset) | the spec markdown: confirmed items only, plus the "Not confirmed — do not build" list |
| `get_item` | `item_id` (UUID or short id `HALV-R7`) | JSON: kind, status, lifecycle, current version + content hash, statement, versions, confirmations/disputes, dependencies; unconfirmed items carry `do_not_build: true` and a `warning` |
| `list_unconfirmed` | `engagement_id` | pending, disputed and revision-pending items under a "Do not build these" header |

## Example prompts

- "Use the veradact MCP server to get the confirmed spec for HALV and implement HALV-R1. Put the item id in the commit message."
- "Before you start, list the unconfirmed items in HALV so you know what not to build."
- "Check HALV-R2 with get_item. If it is not confirmed, stop and tell me."
- "What did the confirmed spec for HALV look like on 2026-03-05?"

## Security

- **Read-only.** No tool changes ledger data; each successful call is metered as an `mcp_fetch` usage event.
- **Org-scoped tokens.** A token resolves to its user and organization; every query runs under row-level security for that organization. Ids from other organizations answer "not found", exactly like ids that do not exist. Revoking the token, or deactivating its user, cuts access immediately.
- **Rate limits.** 120 requests per minute per client IP (checked before authentication) and 60 per minute per token; over the limit the server answers `429` with `Retry-After`. Request bodies are limited to 1 MB.
- **AI-off engagements** never expose source quotes or source titles here; sources are cited by type, date and character offsets (D-027).
- **No secrets in logs.** Logs carry ids, enums and counts only, never tokens, IPs, names or statements. Run the server behind a TLS-terminating proxy that sets `X-Forwarded-For` (the per-IP limit uses its first entry).
