# Veradact — working conventions

Veradact proves what a client agreed to: a typed, versioned, hash-chained record that the client confirms item by item. Read `ARCHITECTURE.md` before changing the domain model and add to `DECISIONS.md` when you make a non-obvious choice. The product spec is `docs/SPEC.md`.

## Commands

```bash
pnpm install
pnpm db:up            # Postgres 16 on :54330, Mailpit on :54331 (smtp) / :54332 (web UI)
pnpm db:migrate       # applies migrations to DATABASE_ADMIN_URL and TEST_DATABASE_ADMIN_URL
pnpm seed             # fictional demo org (Quillfield Labs) + engagement (Halvorsen Freight, HALV)
pnpm dev              # web on :3000, MCP on :3001
pnpm test             # unit + integration (needs db:up)
pnpm test:e2e         # Playwright confirmation flow
pnpm lint
pnpm typecheck
pnpm jobs:run         # reminders + retention, once
```

## Layout

- `packages/core` — `domain/` is pure (no IO, no Date.now — time is passed in); `store/`, `commands/`, `queries/`, `confirmation/`, `auth/`, `jobs/` use the DB.
- `packages/db` — Drizzle schema, migrations (generated + hand-written SQL for roles, RLS, triggers, security-definer functions), `withTenant`.
- `packages/ingest`, `packages/ai`, `packages/export`, `packages/email` — see `ARCHITECTURE.md` §1.
- `apps/web` (Next.js 15 App Router, vendor app + client pages at `/c/[token]`), `apps/mcp` (remote MCP server).

## Invariants (each has tests — keep them green, add tests when you touch them)

1. **Append-only.** The app role cannot UPDATE, DELETE or TRUNCATE `event` (privileges + triggers). Never add code that mutates events.
2. **Projections are a pure function of the log.** `reduce()` in `core/domain/reducer.ts` is the only projection logic. Rebuilding from the log must equal the live tables (property test with 1,000 events).
3. **Hash chain.** Every event's `hash` covers its content and `prev_hash`; `verifyChain` must detect any change. Hash inputs use canonical JSON and millisecond ISO timestamps.
4. **Confirmations bind to one item version** (`content_hash`). A revision creates a new pending version; old confirmations stay in history and never carry over.
5. **Every item version is sourced or explicitly manual**: `spans.length >= 1` XOR `manual = { entered_by }`. Spans are verified against the source text at write time.
6. **Bitemporal.** `occurred_at` = when it was said; `recorded_at` = when it entered the ledger (monotonic per engagement). Replay filters on `recorded_at`.
7. **Tenant isolation.** Every tenant table has RLS on `org_id`. App code only touches tenant data inside `withTenant()`; pre-tenant lookups go through the named `SECURITY DEFINER` functions. Never use `DATABASE_ADMIN_URL` outside migrations, seed and test setup.
8. **No PII or source text in the log.** Contact PII, IP/user agent, dispute comments and source text live in erasable side tables; the log holds ids and HMAC commitments (`ARCHITECTURE.md` §6).
9. **AI-off is real.** When org or engagement AI is off, no source text reaches any model provider; the check is server-side, inside the tenant transaction, before a model client is called.
10. **Humans gate everything.** Nothing enters the ledger without a human accept/edit; nothing reaches a client without a human action.

## Rules

- Log ids, enums and counts only (`core/log.ts`). Never log or put in error messages: source text, statements, quotes, comments, names, emails, IPs, tokens.
- Customer data is never used for training or fine-tuning.
- Client pages: no third-party scripts, fonts, analytics or trackers; must work without JavaScript and on a phone.
- Fixtures and seeds use synthetic data and fictional companies only.
- Don't add a dependency for something trivial; record accepted dependencies in `DECISIONS.md`.
- Out of scope (do not build): meeting capture, audio/video, diarization, voiceprints, communication-health features, monitoring of client employees, billing, SSO, Jira/Salesforce sync, Slack ingestion.
- TypeScript strict. `domain/` functions take time as a parameter. Prefer small modules with a test file next to them (`foo.ts` + `foo.test.ts`); DB integration tests are named `*.int.test.ts`.
- Model name comes from `ANTHROPIC_MODEL`; prompts live in `packages/ai/prompts/*.vN.md` and are never edited in place once used — add a new version.
