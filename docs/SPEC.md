# Deployment Ledger — MVP build spec for Claude Code

> Original product spec, preserved verbatim. Product name: **Veradact** (working name in this spec: "Deployment Ledger").
> Where the implementation deliberately deviates, see `DECISIONS.md`.

You are building the MVP of a B2B SaaS product, working name **Deployment Ledger**. Read this whole file before you write any code. Start in plan mode. Propose the architecture, data model and Phase 1 plan, then wait for my approval before implementing anything.

## Why this exists (context you need for judgment calls)

Vendor teams that build software or AI systems for enterprise clients include forward deployed engineers (FDEs), implementation teams and solutions teams. They lose track of what the client actually asked for. Scope disputes turn on whose memory of the agreement is right, and coding agents get specs nobody on the client side agreed to.

Competitors (Tandem, Rocketlane Nitro, Granola) already **remember what was said**, with cited sources. This product's job is to **prove what the client agreed to**. It is a typed, versioned record that the client confirms item by item, and only confirmed items flow into specs for coding agents.

The plan is 10–12 design partners within 90 days, so a real FDE team must be able to use this end to end by about week 6. Favor a working end-to-end flow over polish. The single most important pilot metric is whether clients actually confirm items, so the confirmation flow and its instrumentation matter more than anything else.

## Users

- **Vendor member (FDE or implementation lead):** logs in, ingests notes and transcripts, curates ledger items, sends confirmation requests, exports specs.
- **Vendor admin:** manages the org, users, engagements and settings.
- **Client confirmer:** has no account and no password. Confirms or disputes items through a signed link. Free and unlimited.

## The MVP is four things. Build only these.

1. **Typed record.** Each engagement holds items of five kinds: problem, constraint, assumption, decision, requirement. Every item version links to the source note or transcript it came from.
2. **Client confirmation.** Every item is pending, confirmed or disputed, with a full audit trail.
3. **Replay.** Show what both sides believed on any past date.
4. **Spec export.** Push only confirmed items to coding agents (Claude Code, Cursor, Kiro), as a markdown file and through an MCP server.

## Core model: an append-only event log per engagement

Think of each engagement as a Kafka topic with log compaction: events are the source of truth, the current state is a projection, and replay reads the log up to a point in time. **Implement this in Postgres.** Do not introduce Kafka or a separate event-store product.

Entities (refine in the plan):
- `org` (vendor tenant), `user` (vendor seat), `engagement` (one client deployment, with a time zone), `client_contact`
- `source` (a note, transcript, email or chat export, with consent attestation fields)
- `event` (append-only; per-engagement sequence number; `prev_hash` and `hash`)
- `item` and `item_version` (projections)
- `confirmation_request`, `audit_log`

Starting event types (propose changes in the plan): `source_ingested`, `item_proposed`, `item_accepted`, `item_revised` (creates a new version), `item_superseded`, `item_withdrawn`, `dependency_added`, `confirmation_requested`, `item_confirmed`, `item_disputed`, `authorization_granted`, `authorization_declined`, `source_redacted`.

**Invariants. Each one needs tests.**
- Events are append-only. Enforce this at the database level (no UPDATE or DELETE on event rows for the app role).
- Projections are a pure function of the log. Rebuilding from scratch yields identical state.
- Events form a per-engagement hash chain, and a verification function detects any tampering.
- A confirmation binds to one exact item version (its content hash). Revising a confirmed item creates a new version with status pending. The old confirmation stays in history but does not carry over.
- Every item version references at least one source span (source id, exact quoted text, character offsets), or is explicitly marked "entered manually by <user>".
- Time is bitemporal: `occurred_at` (when it was said in the source) and `recorded_at` (when it entered the ledger).

**Replay semantics.**
- `as_of(T, view="known")`: every item version recorded by time T, with its status as of T.
- `as_of(T, view="agreed")`: only items confirmed as of T, at the version that was confirmed.
- `diff(T1, T2)`: items added, revised, confirmed or disputed between two times.
- "What did we know when we made decision X?" equals the known-view at X's `recorded_at`, including the status of everything X depends on.

**Dependencies.** Decisions and requirements can reference the assumptions and constraints they rest on. When an upstream item is disputed, revised or superseded, flag its dependents as "needs review". Keep this simple.

## Ingestion: text only, never capture

The product does not record or join meetings. It reads text that already exists.

- Paste or upload `.txt`, `.md`, `.vtt`, `.srt` and `.docx`. **No audio or video uploads.**
- Store the raw text plus metadata: source type (human-written notes, machine transcript, email, chat export), date and participants as given.
- Keep speaker labels exactly as they appear in the source text. Never derive speaker identity from audio. Never compute voiceprints or any biometric identifier.
- **Consent attestation is required for every source at ingest.** The uploader attests the source type, whether all participants consented to the recording (for machine transcripts), and participant states or countries if known.
  - Keep a configurable list of US all-party-consent states. Default to the broader list, because sources disagree: CA, CT, DE, FL, IL, MD, MA, MT, NV, NH, OR, PA, WA.
  - If a machine transcript involves anyone in an all-party state and consent is not attested, block ingest with a clear explanation. Human-written notes are always allowed.
  - Store the attestation as part of the `source_ingested` event.
- Define an ingestion adapter interface so Granola, Gong, Zoom and email forwarding can plug in later. **Do not build those adapters now.** Notes for later: use Granola's enterprise API rather than its MCP server, and Slack limits non-Marketplace apps to one channel-history request per minute.

## AI extraction

- After ingest, an LLM proposes candidate items. Each candidate has a kind, a one-sentence statement, an exact quote from the source with character offsets, the speaker label as it appears in the source, suggested dependencies and a confidence score.
- Verify every quote is an exact substring of the source at the stated offsets. Drop or flag anything that fails. No unsourced candidates ever reach the user.
- When new text appears to change an existing item (for example, a new constraint contradicts a confirmed requirement), propose a revision of that item, not a new item.
- Candidates land in a review queue. **Nothing enters the ledger without a human accept or edit, and nothing is sent to a client without a human action.**
- Use the Anthropic API through the official TypeScript SDK, with the model name set in env config. Keep prompts in versioned files. Build a small eval: 3–5 synthetic transcripts with expected items, runnable as a test, reporting precision and recall.
- **AI-off switch** at org and engagement level. When it is off, members enter items manually and no source text is sent to any model provider. Enforce it server-side and log changes to it. Some client contracts bar AI processing, so this must be real, not cosmetic.
- Never use customer data to train or fine-tune anything. Keep customer content out of application logs and error trackers; log IDs only.

## Client confirmation flow

- A member selects pending or revised items and creates a confirmation request for one or more client contacts.
- Each contact gets an email with a signed, expiring, revocable link bound to that contact. In dev, send email to the console or a local mail catcher.
- The client page needs no login, works on a phone and stays plain. It shows the engagement name and, for each item, its kind, statement, source quote and date, plus a diff against the previously confirmed version if there is one. Per item, the client can Confirm, Dispute (comment required) or Skip. "Confirm all" must show the full list being confirmed.
- On first visit, the contact must grant written authorization for the vendor to process their communications in the ledger, with the exact authorization text displayed. Store it as an event. If they decline, they cannot confirm, and the member is notified.
- For each confirmation, record the contact, item version hash, timestamp, request id, IP address and user agent.
- A dispute sets the item to disputed and notifies the member, who can revise it (new version, back to pending) or withdraw it.
- Send one reminder after 2 business days in the engagement's time zone (configurable). No more than one.
- Make the confirm action channel-agnostic so Slack confirmation can be added later.
- No third-party analytics or trackers on client pages.

## Spec export

- **Markdown spec per engagement.** It contains only confirmed items, grouped by kind. Each item shows a stable short ID (for example `ACME-R7`), its version hash, source citation, confirmer and confirmation date. Add a final section, "Not confirmed — do not build", that lists pending and disputed items by title only, so agents know they exist and leave them alone.
- The file should work as input to spec-driven workflows such as GitHub Spec Kit and as a file dropped into a client's repo.
- **Remote MCP server** (official TypeScript MCP SDK, HTTP transport) with read-only tools: `list_engagements`, `get_confirmed_spec(engagement_id, as_of?)`, `get_item(item_id)` and `list_unconfirmed(engagement_id)`. Authenticate with per-user API tokens scoped to the org. Document in the README how to connect Claude Code and Cursor to it.
- Item IDs must be stable so commits and PRs can reference them.

## Vendor app screens

- Engagement list
- Engagement ledger: items filterable by kind and status; item detail with version history, sources, confirmations and dependencies
- Review queue for AI candidates
- Replay: date picker, known/agreed toggle, diff between two dates
- Record export: the confirmed record as PDF and markdown, including event hashes and the hash-chain verification result (this is the artifact used in scope disputes)
- Metrics

## Metrics (these decide whether the pilots succeed, so build them in Phase 3)

- Share of items sent for confirmation that were confirmed within 5 business days. Target is at least 50%; below 25% is the kill signal.
- Median time to confirm, dispute rate, and how often confirmation links are opened
- Items revised after confirmation, per engagement (requirement churn)
- Spec exports and MCP fetches per engagement
- Show per org and per engagement, with CSV export

## Security and compliance baseline (SOC 2-ready from day one)

- Multi-tenant, with Postgres row-level security on `org_id` for every tenant table. Write tests proving cross-tenant reads and writes fail.
- Roles: admin and member. Secrets in env only; nothing secret in the repo.
- An audit log of user actions: login, ingest, AI-off changes, confirmation requests, exports, deletions.
- **Personal data deletion.** CCPA covers business-contact data, so a client contact's personal data must be erasable without breaking the hash chain. Options include keeping PII in a separate table referenced by ID, or per-subject encryption keys you can destroy. Propose an approach in the plan.
- Source deletion with a `source_redacted` tombstone event. Data retention setting per org.
- Rate limits on public endpoints (client pages, MCP).

## Out of scope. Do not build these, even if they look easy.

- Recording or capturing meetings, audio or video processing, speaker diarization, voiceprints
- Communication-health features such as unanswered messages or silent stakeholders (a competitor already does this)
- Process mining or any monitoring of client employees
- Post-go-live outcome monitoring
- Billing, SSO, Jira or Salesforce sync, Slack ingestion
- Training or fine-tuning on customer data

Leave clean seams for ingestion adapters, confirmation channels, export targets, and metering on **active engagements**, the likely pricing unit (roughly $12K a year for 5 seats and 20 active engagements).

## Suggested stack (change it only with a stated reason)

- TypeScript throughout, pnpm monorepo
- Next.js (App Router) for both the vendor app and client pages
- Postgres 16 with Drizzle; docker-compose for local dev
- Email magic-link auth for vendor users
- Anthropic TypeScript SDK; MCP TypeScript SDK
- Vitest for unit and integration tests; Playwright for the confirmation flow
- Email behind a provider interface, with a local mail catcher in dev

## Build order and acceptance criteria

After each phase: run tests, lint and typecheck, commit, then stop and summarize what you built and what you'd change. Wait for my go-ahead before the next phase.

**Phase 0 — Plan (no application code)**
- `ARCHITECTURE.md`: data model, event types, projection and replay design, hash chain, PII deletion approach, tenant isolation
- `DECISIONS.md`: a running log of decisions and why
- `CLAUDE.md`: conventions, commands, and the invariants above
- Done when I approve the plan.

**Phase 1 — Event store and domain core**
- Schema, append API, projections, `as_of` (known and agreed), `diff`, hash-chain verification, version-bound confirmations, dependency flagging
- Done when every invariant has a test, and a property test with 1,000 random events shows a rebuild from the log equals the live projection.

**Phase 2 — Vendor app, ingestion, extraction**
- Auth, orgs, engagements, source upload with consent attestation, AI extraction with quote verification, review queue, manual entry, AI-off switch
- Done when: every accepted item from the seed transcripts links to a verified quote; with AI off, a mocked model client records zero calls; ingest is blocked for an unattested machine transcript involving an all-party state; the extraction eval runs as a test.

**Phase 3 — Client confirmation and metrics**
- Done when a Playwright test passes: member sends a request, client opens the link, grants authorization, confirms two items and disputes one, the member sees the statuses, the member revises a confirmed item, and it returns to pending without the old confirmation. Expired and revoked links are rejected. The metrics page shows the correct 5-business-day rate on seeded data.

**Phase 4 — Replay UI, record export, spec export, MCP**
- Done when: replay at a past date matches the projection; the PDF and markdown record include hash-chain verification; Claude Code connected to the local MCP server fetches a spec containing only confirmed items plus the "do not build" list.

**Phase 5 — Hardening and demo**
- Cross-tenant RLS tests, audit log, deletion flow, rate limits
- A seed script with a fictional client engagement: 3 transcripts and 20+ items across all statuses
- A README that gets a new developer running locally in under 10 minutes

## How to work

- Plan before coding, and keep `ARCHITECTURE.md` and `DECISIONS.md` current.
- Small commits, with tests alongside each feature.
- If something here is ambiguous or contradictory, ask instead of guessing. If you think part of this spec is wrong, say so and explain why.
- Don't add a dependency for something trivial.
- Use only synthetic data and fictional company names in fixtures and seeds.
