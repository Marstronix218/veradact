# Veradact

Veradact proves what a client agreed to. Requirements, decisions, assumptions, constraints and problems from meeting notes and transcripts become a typed, versioned, hash-chained ledger that the client confirms item by item through a link, and only client-confirmed item versions flow into the spec your coding agents build from (over MCP).

Everything here is synthetic: the demo org (Quillfield Labs) and client (Halvorsen Freight) are fictional.

## Prerequisites

- **Node 22** (`.nvmrc`; `nvm use`)
- **pnpm 10** (`corepack enable` picks up the version pinned in `package.json`)
- **Docker** (the Supabase CLI runs its services in containers)
- **Supabase CLI** 2.75 or later (`brew install supabase/tap/supabase`, or see the [install guide](https://supabase.com/docs/guides/local-development/cli/getting-started)). Supabase is the database host. Locally it runs Postgres 17, Mailpit and Studio; Supabase Auth, Storage and the client SDK are not used (D-061).

Ports used: 54330 (Postgres), 54331 (Mailpit SMTP), 54332 (Mailpit web UI), 54333 (Supabase API gateway), 54334 (Supabase Studio), 3000 (web app), 3001 (MCP server).

## Quickstart

```bash
pnpm install
cp .env.example .env      # dev-only values; works as is
pnpm db:up                # local Supabase: Postgres on :54330, Mailpit on :54331/:54332, Studio on :54334
pnpm db:migrate           # dev and test databases
pnpm seed                 # demo org, users, engagements; prints the logins and an MCP token
pnpm dev                  # web on http://localhost:3000, MCP on http://localhost:3001/mcp
```

Then sign in:

1. Open http://localhost:3000 and enter **admin@quillfield.example** (the seed also creates a member, tomas@quillfield.example).
2. Open Mailpit at http://localhost:54332, open the "Your Veradact sign-in link" email and click the link.
3. Press **Sign in to Veradact**. You land on the engagements list.

No API key is needed: without `ANTHROPIC_API_KEY`, AI extraction uses the `fixture` client, which answers from the repository's synthetic fixtures and sends nothing anywhere.

Timed from a fresh clone with the pnpm store warm and the Docker images already pulled: about 20 seconds of commands to a signed-in session (breakdown at the bottom of this file), so the 10-minute budget is mostly reading. A cold `pnpm install` (~480 packages) and the first `supabase start` (it pulls the Supabase images, about 1 GB) add a few minutes depending on the network. `pnpm db:down` stops the stack and keeps its data.

## A 5-minute demo tour

Open **Halvorsen Freight — AI dispatch routing** (short code `HALV`).

1. **Ledger.** 23 items across all kinds, statuses and lifecycles. Filter by kind, status or "needs review"; `lifecycle=all` shows superseded and withdrawn items.
2. **An item.** Open `HALV-R…` items: each version shows its verified quote with the source and speaker, a word diff against the previous version, client responses with the confirmer's name and email domain, dependencies, and actions (revise, withdraw, supersede, clear review). The revised requirement shows a confirmed version 1 and a pending version 2 — confirmations never carry over.
3. **Review queue.** Sources → **Add source** → upload `fixtures/eval/e2-insurer-notes.md` as human notes, tick the attestation and submit. The fixture client proposes candidates, including deliberately flawed ones (a corrected quote offset, dropped hallucinations). Accept, edit or reject them in the review queue.
4. **Send a confirmation request.** Confirmations → tick a few pending items (four were never sent) and a contact (e.g. Marcus Oyelaran) → **Send request**.
5. **Be the client.** In Mailpit, open the request email to `marcus.oyelaran@halvorsen-freight.example` and open the link (it works without JavaScript and on a phone). Grant authorization, confirm one item, dispute another with a comment, submit. The receipt lists content hashes and the log head.
6. **Back as the vendor.** The ledger shows the new statuses; Notifications has the dispute.
7. **Metrics.** The org view and the `PILOT` engagement show the 5-business-day confirmation rate (60%, on target), median time to confirm, dispute rate, link engagement and churn; download the CSV.
8. **Replay.** Pick a past date (e.g. 2026-09-20): the known and agreed views, a comparison between two dates, and "What did we know when this was decided?" on a decision.
9. **Export.** The export page verifies the hash chain live; download `spec.md` (confirmed items plus a "do not build" list) and the record as markdown or PDF (every event, chain verification, evidence status per response).
10. **MCP.** Connect a coding agent (next section) and ask it for the confirmed spec of `HALV`.

## Connect Claude Code or Cursor (MCP)

`pnpm dev` also starts the MCP server at http://localhost:3001/mcp (read-only tools: `list_engagements`, `get_confirmed_spec`, `get_item`, `list_unconfirmed`). Use the token printed by `pnpm seed`, or create one under **Settings → API tokens** (shown once).

Claude Code:

```bash
claude mcp add --transport http veradact http://localhost:3001/mcp --header "Authorization: Bearer vdt_..."
```

Cursor (`.cursor/mcp.json` in your project, or `~/.cursor/mcp.json`):

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

Then ask, for example: "Use veradact to get the confirmed spec for HALV and list what I must not build yet."

## Running tests

```bash
pnpm test                                    # unit + integration (Vitest); needs `pnpm db:up`; resets the veradact_test database
pnpm --filter @veradact/web exec playwright install chromium   # once
pnpm test:e2e                                # Playwright against the dev server (starts `pnpm dev` if none is running)
pnpm --filter @veradact/ai eval              # extraction precision/recall on recorded model responses
EVAL_LIVE=1 ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @veradact/ai eval   # the same against the live model
pnpm typecheck && pnpm lint
```

The e2e suite reuses a dev server already running on :3000 (it must run with `EMAIL_PROVIDER=smtp`, the `.env` default) and clears the dev database's rate-limit windows at start.

## AI configuration

| variable | meaning |
|---|---|
| `ANTHROPIC_API_KEY` | enables the Anthropic model client |
| `ANTHROPIC_MODEL` | model name (default in `.env.example`) |
| `MODEL_CLIENT` | `anthropic` or `fixture`; empty = `anthropic` when a key is set, else `fixture` (D-051) |

AI can be switched off per org (admin, Settings) or per engagement (engagement Settings). When it is off, no source text reaches any model provider — enforced server-side — and spec exports and MCP output omit quotes, source titles and contact names. Customer data is never used for training.

## Scheduled jobs

```bash
pnpm jobs:run    # reminders, then retention, once
curl -X POST -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/reminders   # hourly in production
curl -X POST -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/retention   # daily in production
```

Reminders send one email per link after the org's reminder business days. Retention redacts sources older than the org's retention window (Settings → "Delete source text after (days)") and prunes old rate-limit windows. After a fresh seed, `pnpm jobs:run` sends two reminder emails to Mailpit.

## Project layout

```
apps/web          Next.js 15 vendor app, client pages (/c/[token]), cron and export routes
apps/mcp          remote MCP server (Streamable HTTP, bearer API tokens)
packages/core     domain (pure: events, hashing, reducer, replay, metrics, consent) + services (store, commands, queries, confirmation, auth, jobs)
packages/db       Drizzle schema, SQL migrations (roles, RLS, append-only triggers, definer functions), withTenant
packages/ingest   parsers for .txt .md .vtt .srt .docx
packages/ai       model client, versioned prompts, quote verification, eval
packages/export   spec and record renderers (markdown, PDF) + shared DB loaders
packages/email    console | smtp | memory providers
packages/seed     the demo seed
fixtures/         synthetic transcripts, seed data and eval sets
```

## Where the rules live

- [`CLAUDE.md`](CLAUDE.md) — working conventions and the ten invariants (append-only log, projections from the log, hash chain, version-bound confirmations, sourced-or-manual, bitemporal, tenant isolation, no PII in the log, AI-off, humans gate everything). Each has tests.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — data model, events, hash chain, replay, erasure and redaction (§6), tenant isolation (§7), client confirmation (§8), security baseline and rate limits (§14), deployment (§17).
- [`DECISIONS.md`](DECISIONS.md) — every non-obvious choice and why.
- [`docs/SPEC.md`](docs/SPEC.md) — the product spec.

## Deployment notes

See ARCHITECTURE §17 (§17.2 for the Vercel pilot). In short: any Node 22 host for `apps/web` (it also serves the MCP endpoint at `/mcp`), a Supabase project as the database (Data API and Supabase Auth sign-ups off, network restrictions on; migrations as `postgres`, the apps as `veradact_app` through the pooler with TLS verified; step by step in §17.1; `pnpm db:cloud-setup` does the database part in one command), any SMTP provider with a verified sending domain (`EMAIL_PROVIDER=smtp`, `SMTP_URL`, `EMAIL_FROM`), and a scheduler calling the cron routes. Also:

- Generate `SESSION_SECRET`, `LINK_SIGNING_SECRET` and `CRON_SECRET` with `openssl rand -base64 32`. In production the app refuses to start with the `.env.example` placeholders.
- Set `APP_URL` to the public https URL and `TRUSTED_PROXY_HOPS` to exactly the number of trusted proxies that append to `X-Forwarded-For` (1 for a single load balancer or platform router such as Fly, Render, Railway or Heroku; 2 for a CDN in front of a load balancer). Rate limits and evidence IPs depend on it. Running without a proxy is unsupported in production: with `TRUSTED_PROXY_HOPS=0` every web request would share one rate-limit key, so the web app refuses to start (ARCHITECTURE §14).
- **Do not let proxies, CDNs or load balancers log the path of `/c/*` or `/auth/verify` requests**: client links and magic links carry their token in the URL.

## Troubleshooting

- **A port is in use** (54330–54338, 3000, 3001): `lsof -nP -iTCP:<port> -sTCP:LISTEN` shows the process. Stop it, or change the port in `supabase/config.toml` and the matching URLs in `.env` (`DATABASE_URL`, `SMTP_URL`, `APP_URL`, `MCP_PORT`/`MCP_PUBLIC_URL`).
- **`pnpm seed` says the demo org already exists**: `pnpm seed --reset` purges it and seeds again (dev databases on localhost only; refuses in production).
- **Playwright cannot find a browser**: `pnpm --filter @veradact/web exec playwright install chromium`.
- **`next build` breaks a running `pnpm dev`** (or the reverse): both use `apps/web/.next`. Stop the dev server before building, or build in a copy (`cp -c -R` on macOS makes an instant clone).
- **No sign-in email**: check that the stack runs (`supabase status`) and that `.env` has `EMAIL_PROVIDER=smtp` and `SMTP_URL=smtp://localhost:54331`. Login requests are rate limited (20 per 15 minutes per IP, 5 per address, ARCHITECTURE §14) and still answer "check your email" when limited; wait 15 minutes or clear the windows in the dev database with `docker exec supabase_db_veradact psql -U postgres -c 'delete from rate_limit_bucket'`.
- **Tests hang at "waiting for another test run"**: another `pnpm test` holds the test database; it continues when that run ends.

## Quickstart timing

Measured on 2026-11-01 from a fresh APFS clone without `node_modules` and a fresh `.env`, with the pnpm store warm, the Docker images pulled and the containers already up (the database steps re-measured on 2026-11-02 against the local Supabase stack):

| step | time |
|---|---|
| `pnpm install` | 2.7 s |
| `cp .env.example .env` | < 1 s |
| `pnpm db:up` | 1.2 s |
| `pnpm db:migrate` | 0.7 s |
| `pnpm seed --reset` | 2.5 s |
| `pnpm dev` until the login page answers | 8.2 s |
| login: request link, open it from Mailpit, sign in | 4.3 s (scripted with Playwright) |
| **total** | **about 20 s** |
