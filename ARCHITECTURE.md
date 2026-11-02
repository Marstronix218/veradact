# Veradact — Architecture

Veradact proves what a client agreed to. Each engagement is an append-only, hash-chained event log in Postgres. Current state is a projection of that log, replay is a fold of the log up to a point in time, and only client-confirmed item versions flow into specs for coding agents.

Product spec: [`docs/SPEC.md`](docs/SPEC.md). Decision log: [`DECISIONS.md`](DECISIONS.md). Working conventions: [`CLAUDE.md`](CLAUDE.md).

---

## 1. System overview

```
                ┌──────────────────────── apps/web (Next.js 15, App Router, Node runtime) ──────────┐
 vendor user ──▶│ /login, /engagements/**, /metrics, /settings     (session cookie, RLS tenant ctx)  │
 client     ──▶ │ /c/[token]   route handlers emitting plain escaped HTML, no JS, no third-party     │
 cron       ──▶ │ /api/cron/reminders, /api/cron/retention          (bearer CRON_SECRET)             │
                └───────────────┬───────────────────────────────────────────────────────────────────┘
                                │ calls services
 coding agent ─▶ apps/mcp (Node http, MCP SDK Streamable HTTP, bearer API token) ─┐
                                ▼                                                 ▼
          packages/core  — domain (pure): events, canonical JSON + hashing, reducer, replay, diff,
                           dependencies, business days, metrics, consent policy, word diff
                         — services (DB): append API, commands, queries, confirmation, auth, jobs
          packages/db    — Drizzle schema, SQL migrations (roles, RLS, triggers), withTenant
          packages/ingest— parsers (.txt .md .vtt .srt .docx), IngestionAdapter interface
          packages/ai    — ModelClient (Anthropic SDK), versioned prompts, quote verification, eval
          packages/export— spec markdown, record markdown + PDF, ExportTarget interface
          packages/email — EmailProvider: console | smtp (Mailpit in dev) | memory (tests)
                                ▼
                       Postgres 16 (docker compose, port 54330) · Mailpit (54331 smtp / 54332 ui)
```

Dependency direction: `apps/* → core → db`; `core → ingest, ai, email`; `export → core` (types only for the pure renderers; the `@veradact/export/server` loaders also use core and db at runtime, D-048; core never imports export). `core/domain` does no IO and never reads the clock (time is a parameter). Packages are consumed as TypeScript source (no build step); Next uses `transpilePackages`, scripts and the MCP server run on `tsx --env-file`. No DB access from Next middleware (postgres.js needs the Node runtime).

### 1.1 Conventions every module relies on
- **Text and offsets.** Source text is normalized once at ingest: Unicode NFC, `\r\n`/`\r` → `\n`. Offsets are JavaScript string indices (UTF-16 code units) into that normalized text. `content_sha256` = SHA-256 over the UTF-8 bytes of the normalized text.
- **Time.** All timestamps are `timestamp(3) with time zone`, produced by the application clock and truncated to milliseconds before hashing and insert. SQL never supplies `now()` or a default for `recorded_at`/`occurred_at`. Every command takes a `clock: () => Date` (system clock in production, a stepping fake clock in tests and seed).
- **Dates entered by users** (source date, replay date picker, MCP `as_of`): a date-only value means start of that day in the engagement's time zone for `occurred_at`, and **end** of that day (23:59:59.999 local) for `as_of`. A full ISO timestamp is used as is.
- **postgres.js** is configured to parse `int8` as JS `number` (seq values are far below 2^53) and to return `jsonb` as parsed objects; hashing never goes through zod-transformed objects (§4).
- **Isolation level** is READ COMMITTED (Postgres default); the append lock in §5.2 depends on it.

---

## 2. Data model

All tenant tables carry `org_id uuid not null` and have RLS enabled (§7). Foreign keys between tenant tables are composite `(id, org_id)` so a row can never point into another tenant (Postgres FK checks bypass RLS). IDs are UUIDv4 generated in the application unless noted.

**FK rule:** operational tables (§2.4) may reference only `org`, `app_user`, `engagement`, `client_contact` and `event` — never projection tables (§2.3) — and nothing cascades into or out of projections. This lets rebuild delete and rewrite projections freely.

### 2.1 Tenancy and identity (mutable, operational)

| table | key columns | notes |
|---|---|---|
| `org` | `id, name, slug, ai_enabled bool=true, retention_days int null, all_party_states text[]` (default §9.2), `block_unknown_jurisdictions bool=true, reminder_business_days int=2, created_at` | RLS: `id = current org`. Created only by `pnpm org:create` (admin URL) |
| `app_user` | `id, org_id, email citext unique, name, role ('admin'\|'member'), deactivated_at, created_at` | one org per user in MVP |
| `login_token` | `id, org_id, user_id, token_hash, expires_at (15 min), used_at` | single use via `UPDATE … WHERE used_at IS NULL RETURNING` |
| `session` | `id, org_id, user_id, token_hash unique, expires_at (30 d), revoked_at, last_seen_at` | cookie `vd_session` holds the raw token |
| `api_token` | `id, org_id, user_id, name, token_prefix, token_hash unique, last_used_at, revoked_at` | MCP bearer tokens `vdt_<base64url>` |
| `engagement` | `id, org_id, name, client_name, short_code, time_zone, ai_enabled bool=true, status ('active'\|'archived'), created_by, created_at, archived_at` | `short_code` (A–Z0–9, 2–8, unique per org) is **immutable**. Name/client/time-zone changes go through `engagement_updated` (§3) and are mirrored here. `status='active'` is the metering unit |
| `client_contact` | `id, org_id, engagement_id, created_at, erased_at` | **no PII**; the id is the subject id used in events |
| `contact_pii` | `contact_id pk, org_id, name, email, title, hmac_key bytea(32)` | erasable (§6) |

Raw secrets are never stored: `*_hash = sha256(raw token)`.

### 2.2 The log

`event` — append-only, hash-chained per engagement.

| column | type | notes |
|---|---|---|
| `id` | `bigint generated always as identity` | global insert order, not semantic, not hashed |
| `org_id, engagement_id` | uuid | |
| `seq` | bigint | 1..n per engagement, `unique(engagement_id, seq)` |
| `type` | text | §3 |
| `schema_version` | smallint | starts at 1 |
| `payload` | jsonb | validated by zod on write; **no PII, no source text, no free text other than item statements** (§6); integers only, no floats |
| `actor_type, actor_id` | text, uuid null | `user` (app_user id), `contact` (client_contact id), `system` |
| `occurred_at` | timestamptz(3) | when it was said/happened. Item events: the cited source's `occurred_at` (or a member-supplied date for manual items). All other events: equal to `recorded_at` |
| `recorded_at` | timestamptz(3) | when it entered the ledger; non-decreasing per engagement |
| `prev_hash, hash` | char(64) | §4 |

`engagement_head (engagement_id pk, org_id, head_seq, head_hash, head_recorded_at)` — maintained only by the insert trigger (SECURITY DEFINER trigger function; the app role has `SELECT` only).

Database enforcement (hand-written migration SQL):
- `REVOKE UPDATE, DELETE, TRUNCATE ON event FROM veradact_app, PUBLIC`; app role gets `SELECT, INSERT`.
- `BEFORE UPDATE OR DELETE` row trigger and `BEFORE TRUNCATE` statement trigger raise `event log is append-only` for every role (tests simulate tampering by having the owner disable the trigger).
- `BEFORE INSERT` trigger: `seq = head_seq + 1`, `prev_hash = head_hash` (genesis: `seq = 1`, `prev_hash` = 64 × `0`), `recorded_at >= head_recorded_at`; then upserts `engagement_head`. Hash *content* is computed and verified in TypeScript (§4).

### 2.3 Projections (rebuildable from the log — §5)

| table | key columns |
|---|---|
| `source` | `id, org_id, engagement_id, source_type, format, occurred_at, recorded_at, content_sha256, char_length, participant_count, attestation jsonb, ingested_by, redacted_at, redaction_reason` (title/filename live in `source_content`) |
| `item` | `id, org_id, engagement_id, short_id (unique per engagement), kind, current_version, status ('pending'\|'confirmed'\|'disputed'), lifecycle ('active'\|'superseded'\|'withdrawn'), superseded_by, needs_review bool, review_reasons jsonb, created_at, updated_at, last_seq` |
| `item_version` | `item_id, version (pk pair), org_id, engagement_id, content_hash, statement, spans jsonb, manual jsonb null, provenance jsonb, reason_code, occurred_at, recorded_at, event_seq` |
| `item_dependency` | `org_id, engagement_id, item_id, depends_on_item_id, added_seq` |
| `item_response` | `org_id, engagement_id, event_seq, item_id, version, content_hash, contact_id, request_id, submission_id, response ('confirmed'\|'disputed'), comment_commitment null, recorded_at` |
| `confirmation_request` | `id, org_id, engagement_id, requested_by, expires_at, recorded_at, event_seq` |
| `confirmation_request_item` | `org_id, engagement_id, request_id, item_id, version, content_hash` |
| `confirmation_request_contact` | `org_id, engagement_id, request_id, contact_id, revoked_at null` |
| `contact_authorization` | `org_id, engagement_id, contact_id, request_id, decision ('granted'\|'declined'), text_version, text_sha256, recorded_at, event_seq` (latest per contact wins) |

### 2.4 Operational tables (mutable, outside the log)

| table | purpose |
|---|---|
| `source_content` | `source_id pk, org_id, engagement_id, title, filename, text` (normalized; offsets refer to this), `raw_text, participants jsonb` (as given), `segments jsonb` (`[{speaker, start, end}]`). Deleted on redaction. |
| `event_note` | `event_id pk, org_id, note` — optional free-text explanation for revise/withdraw/supersede/redact; erasable, never hashed |
| `extraction_run` | `id, org_id, engagement_id, source_id, model, prompt_version, status, proposed_count, dropped_count, corrected_count, error_code, created_at, finished_at` — ids and counts only |
| `candidate` | review queue: `id, org_id, engagement_id, source_id, extraction_run_id, ordinal, kind, statement, quote, start, end, speaker_label, suggested_depends_on jsonb, confidence real, revises_item_id null, verification ('exact'\|'offset_corrected'), status ('pending'\|'accepted'\|'rejected'), decided_by, decided_at, resulting_item_id` |
| `confirmation_link` | `id, org_id, engagement_id, request_id, contact_id, sent_to_email` (erasable copy), `expires_at, revoked_at, email_sent_at, reminder_sent_at, first_opened_at, last_opened_at, open_count, first_interaction_at` |
| `confirmation_evidence` | `event_id pk → event.id, org_id, contact_id, name, email, ip, user_agent` — snapshot at response time; erasable |
| `response_comment` | `event_id pk → event.id, org_id, contact_id, comment` — erasable |
| `notification` | `id, org_id, user_id, engagement_id, kind ('item_disputed'\|'authorization_declined'), item_id null, contact_id null, read_at, created_at` |
| `usage_event` | `id, org_id, engagement_id, kind ('spec_export'\|'record_export_md'\|'record_export_pdf'\|'mcp_fetch'), user_id, api_token_id, tool, created_at` |
| `audit_log` | `id, org_id, actor_user_id, action, target_type, target_id, metadata jsonb (ids/enums only), created_at` — app role `SELECT, INSERT` only |
| `rate_limit_bucket` | `key (sha256), window_start, count` — no tenant data, the only table without RLS |

---

## 3. Event types (schema_version 1)

Payloads are zod schemas in `packages/core/src/domain/events.ts`. Enum reason codes keep free text out of the log; an optional explanation goes to `event_note`.

`Span = { source_id, source_sha256, start, end }`. The quote is `source_content.text.slice(start, end)`; it is verified at write time and at view time by checking `sha256(source text) == source_sha256`. After redaction the span remains (and keeps the item's content hash stable) but the quote can no longer be shown.

| type | payload | notes |
|---|---|---|
| `engagement_created` | `engagement_id, short_code, name, client_name, time_zone` | always seq 1 (genesis) |
| `engagement_updated` | `name?, client_name?, time_zone?` | keeps the reducer's engagement copy current |
| `source_ingested` | `source_id, source_type ('human_notes'\|'machine_transcript'\|'email'\|'chat_export'), format ('txt'\|'md'\|'vtt'\|'srt'\|'docx'\|'paste'), content_sha256, char_length, participant_count, attestation` | `occurred_at` = source date. `attestation = { attested_by, source_type, all_participants_consented: bool\|null, participant_jurisdictions: string[], jurisdictions_known: bool, policy: { version, all_party_states, block_unknown_jurisdictions }, decision: 'allowed', rule }`. No title/filename (PII risk) |
| `source_redacted` | `source_id, reason_code ('user_request'\|'retention'\|'consent_withdrawn'\|'uploaded_in_error'\|'other')` | tombstone; content row deleted in the same transaction |
| `item_created` | `item_id, short_id, kind, version: 1, statement, spans: Span[], manual: {entered_by} \| null, depends_on: item_id[], provenance: { via: 'manual'\|'ai_candidate', candidate_id?, model?, prompt_version?, edited? }, content_hash` | replaces spec's `item_proposed` + `item_accepted` (D-004) |
| `item_revised` | `item_id, version (n+1), statement, spans, manual, provenance, reason_code ('client_dispute'\|'new_information'\|'correction'\|'scope_change'\|'other'), content_hash, previous_content_hash` | kind is immutable. Spans: carried-over spans are copied as they were (flag `carried: true` in the projection), the member may add or remove spans; zero spans ⇒ `manual` |
| `item_superseded` | `item_id, superseded_by_item_id, reason_code` | |
| `item_withdrawn` | `item_id, reason_code ('client_dispute'\|'out_of_scope'\|'duplicate'\|'entered_in_error'\|'other')` | |
| `dependency_added` / `dependency_removed` | `item_id, depends_on_item_id` | dependents must be `decision`/`requirement`; no self-edges, no cycles |
| `review_cleared` | `item_id` | member acknowledges a needs-review flag |
| `confirmation_requested` | `request_id, items: [{item_id, version, content_hash}], contact_ids, expires_at, channel: 'email_link'` | |
| `confirmation_revoked` | `request_id, contact_id \| null` (null = all contacts) | |
| `authorization_granted` / `authorization_declined` | `contact_id, request_id, text_version, text, text_sha256, evidence_commitment` | `text` = exact rendered authorization text (vendor + engagement names only) |
| `item_confirmed` | `item_id, version, content_hash, contact_id, request_id, submission_id, channel, evidence_commitment` | |
| `item_disputed` | `item_id, version, content_hash, contact_id, request_id, submission_id, channel, evidence_commitment, comment_commitment` | comment text lives in `response_comment` |
| `contact_erased` | `contact_id` | marks erasure in the record (§6) |

`content_hash = sha256(canonical({ engagement_id, item_id, kind, version, statement, spans, manual }))`. Version and item id are included, so a confirmation of v1 can never match v3 even with identical text; `spans` include `source_sha256`, so the hash also binds the exact quoted evidence. Dependencies are not part of confirmed content.

Short ids: `<SHORT_CODE>-<K><n>`, K ∈ {P problem, C constraint, A assumption, D decision, R requirement}, n = 1 + count of items of that kind, allocated under the engagement lock and **stored in the payload**, so ids never change and the projection stays pure.

---

## 4. Hash chain

```
hash = sha256_hex(canonical({
  v: 1, org_id, engagement_id, seq, type, schema_version,
  payload, actor: { type, id }, occurred_at, recorded_at, prev_hash
}))
```
- `canonical()` = JSON with recursively sorted object keys, no whitespace, arrays in order; rejects `undefined`, non-integer and non-finite numbers. Timestamps are ISO strings from `Date.toISOString()` (ms, UTC). In-house (D-008).
- Genesis `prev_hash` = 64 zeros. `recorded_at = max(clock(), head.recorded_at)`.
- `verifyChain(rows, expectedHead?) → { ok, checked, headSeq, headHash, firstBadSeq?, reason?: 'seq_gap'|'prev_hash_mismatch'|'hash_mismatch'|'truncated' }` hashes the **raw stored row values** (jsonb as returned by the driver, not zod output). `expectedHead` comes from `engagement_head`, and from heads printed in earlier exports and receipts; a log shorter than, or diverging from, a known head is `truncated`.
- A round-trip test appends events, reads them back through the same query the exports use, and re-verifies.
- External anchoring: the client's receipt email (§8.6) and every record export carry the head seq and hash, so a rewritten history contradicts copies the vendor does not control.

---

## 5. Projection, append and replay

### 5.1 One reducer
`reduce(state: EngagementState, event: StoredEvent) → EngagementState` in `core/domain/reducer.ts` is the **only** projection logic. Pure, total (never throws on a well-formed event; invalid transitions are rejected earlier by commands), deterministic.

```ts
EngagementState = {
  engagement: { id, orgId, shortCode, name, clientName, timeZone }
  headSeq, headHash, headRecordedAt
  sources:  Map<id, { id, sourceType, format, occurredAt, recordedAt, contentSha256, charLength, participantCount, attestation, ingestedBy, redacted: {at, reasonCode} | null }>
  items:    Map<id, { id, shortId, kind, versions: ItemVersion[], currentVersion, lifecycle, supersededBy, dependsOn: Set<id>, needsReview, reviewReasons: {upstreamItemId, cause, seq}[], responses: Response[], createdAt, updatedAt, lastSeq }>
  requests: Map<id, { id, items: {itemId, version, contentHash}[], contactIds, revokedContactIds: Set, revokedAll, expiresAt, requestedBy, recordedAt, seq }>
  authorizations: Map<contactId, { decision, requestId, textVersion, textSha256, at, seq }>
  submissions: Set<submissionId>
  erasedContacts: Set<contactId>
  kindCounters: Record<Kind, number>
}
```

Status is derived: for the current version, take the latest response per contact; any `disputed` → `disputed`; else any `confirmed` → `confirmed`; else `pending` (D-009). Responses against a non-current version stay in history and never affect status — this is what makes confirmations version-bound.

Needs-review: on `item_revised`, `item_superseded`, `item_withdrawn`, or `item_disputed` (current version) of upstream U, every direct dependent D of U gets `needsReview = true` plus a reason. Cleared by `item_revised` of D or `review_cleared` of D (D-011).

### 5.2 Append API (live path)
`appendEvents(tx, engagementId, drafts, { clock })` in `core/store/append.ts`, always inside `withTenant`:
1. `pg_advisory_xact_lock(hashtextextended(engagement_id::text, 0))` — serializes writers per engagement (READ COMMITTED, so reads after the lock see the latest committed log).
2. `loadState`: fold the engagement's log (D-006).
3. For each draft: assign `seq`, `recorded_at`, `prev_hash`; compute `hash`; insert; `state = reduce(state, stored)`.
4. Rewrite the engagement's projection rows from `state` (`core/store/projection-writer.ts`: delete the engagement's projection rows, insert all). A diffing writer can replace this later.
5. Commit together with the command's operational writes.

Commands (`core/commands/*`) validate against loaded state *before* producing drafts: item active, version/hash match, contact authorized, request includes the item version and is unexpired/unrevoked, submission id unused, dependency rules, new spans verified against `source_content` (`text.slice(start,end)` equals the quote the member/candidate supplied, `sha256(text) == source_sha256`), carried-over spans copied unchanged (no re-verification needed, so revising an item whose source was redacted works), consent policy, AI-off.

### 5.3 Rebuild path
`rebuildProjections(tx, engagementId)` = fold the full log from `emptyState()` + the same projection writer. Invariant test: after random command sequences through the live path, a canonical dump of every projection table equals the dump after rebuild and equals `projectRows(fold(events))` computed purely (property test, 1,000 events, fast-check).

### 5.4 Replay (pure over `StoredEvent[]`)
- `asOf(events, T, 'known')` = `fold(events with recordedAt <= T)` → every item and every version recorded by T with status, lifecycle and needs-review as of T.
- `asOf(events, T, 'agreed')` = items whose status at T is `confirmed` and lifecycle `active`, at the confirmed (current) version, with confirmers and dates; plus `previouslyAgreed` (items with an earlier confirmed version whose current version at T is pending/disputed) as context only (D-010).
- `diff(events, T1, T2)` = per-item comparison of `asOf(T1)` and `asOf(T2)` plus the events in `(T1, T2]`: `added`, `revised (from → to)`, `confirmed`, `disputed`, `superseded`, `withdrawn`.
- `decisionContext(events, itemId, version?)` = known view folded through the **seq** of that version's event (inclusive; batches share a millisecond), plus each dependency of X with its version and status at that point.

---

## 6. Personal data and redaction (erasure without breaking the chain)

Rule: **anything that identifies or was authored by a client contact, all source text and metadata, and all free-text notes live outside the log. The log stores ids, enums, hashes and keyed commitments.** Erasure deletes off-log rows and keys; event rows are untouched, so the chain still verifies.

| data | where | in the log | erased by |
|---|---|---|---|
| contact name, email, title | `contact_pii` | `contact_id` only | contact erasure |
| confirmer identity + IP + user agent at response time | `confirmation_evidence` (snapshot) | `evidence_commitment = HMAC(contact key, canonical{name, email, ip, user_agent})` | contact erasure |
| address a link was sent to | `confirmation_link.sent_to_email` | — | contact erasure |
| dispute comment | `response_comment` | `comment_commitment = HMAC(contact key, comment)` | contact erasure |
| source text, title, filename, participants, speaker labels | `source_content` | `content_sha256`, spans (`source_id, source_sha256, start, end`) | source redaction / retention |
| member explanations | `event_note` | `reason_code` enum | retention (with source) or never |
| item statement | event payload | statement | not erasable: the vendor-authored agreement itself; UI warns not to include personal data (D-012) |

- `eraseContact(contactId)`: delete `contact_pii` (with its HMAC key), the contact's `confirmation_evidence` and `response_comment` rows, null `sent_to_email`, revoke links, set `client_contact.erased_at`, append `contact_erased`, audit. Exports render "Erased contact".
- `redactSource(sourceId, reasonCode)`: delete `source_content` and pending candidates from that source, append `source_redacted`, audit. Item versions keep their spans; the UI shows "source redacted on <date>" instead of the quote.
- Record exports verify each `evidence_commitment` against its evidence snapshot: `verified`, `erased` or `mismatch`.
- Vendor users: deactivation anonymizes `app_user.email/name`; events reference user ids only.
- Retention: `org.retention_days`, measured from the source's `recorded_at`; the job redacts older sources (`reason_code: 'retention'`) and deletes their candidates.

---

## 7. Tenant isolation

- Roles: `veradact_admin` owns all objects, runs migrations, seed and `org:create`. `veradact_app` (`NOSUPERUSER NOBYPASSRLS`) is the only role the apps use.
- Every tenant table: `ENABLE ROW LEVEL SECURITY` + policy `USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org())`, `app_current_org()` = `nullif(current_setting('app.org_id', true), '')::uuid`. No setting → no rows.
- `withTenant(db, { orgId, userId? }, fn)` opens a transaction, runs `select set_config('app.org_id', $1, true)`, then `fn(tx)`. All tenant data access goes through it.
- Pre-tenant lookups: narrow `SECURITY DEFINER` functions owned by `veradact_admin`, `SET search_path = public, pg_temp`, `REVOKE EXECUTE … FROM PUBLIC`, `GRANT EXECUTE … TO veradact_app`, returning ids only: `auth_find_user_by_email(email)`, `auth_consume_login_token(hash)` (single-use `UPDATE … RETURNING`), `auth_resolve_session(hash)`, `auth_resolve_api_token(hash)`, `link_resolve(link_id)`, `jobs_list_org_ids()`.
- Jobs iterate `jobs_list_org_ids()` and do all work per org inside `withTenant`.
- Tests: (1) a catalog sweep fails on any `public` table without RLS enabled and an `org_id` column, except an allow-list (`rate_limit_bucket`, migration bookkeeping); (2) for every tenant table, a session scoped to org A cannot read, insert, update or delete org B rows, and `insert … org_id = B` fails `WITH CHECK`.

---

## 8. Client confirmation

### 8.1 Request
Member selects pending/disputed items + contacts → `requestConfirmation` validates → appends `confirmation_requested` → one `confirmation_link` per contact (default expiry 14 days, `sent_to_email` copied) → delivered via `ConfirmationChannel` (`email_link`) → audit. Nothing is sent without this explicit member action.

### 8.2 Link token (signed, expiring, revocable, contact-bound)
`v1.<link_id>.<exp_unix>.<sig>`, `sig = base64url(HMAC-SHA256(LINK_SIGNING_SECRET, "v1|link_id|contact_id|exp"))`. Validation: parse → `link_resolve(link_id)` → constant-time signature check with the resolved contact id → `exp` and `expires_at` in the future → link not revoked and request/contact not revoked in state → contact not erased. Every failure renders the same plain "This link is no longer valid" page (HTTP 410).

### 8.3 Client page `/c/[token]`
Implemented as Next **route handlers** (GET renders, POST handles forms) that return HTML built with a small auto-escaping `html` tagged template — no React hydration, no JavaScript, mobile-first inline-free stylesheet served from `/c/static/client.css`. Headers: `Content-Security-Policy: default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`, `Cache-Control: no-store`. No third-party resources, analytics or fonts.
1. GET increments `open_count` / `first_opened_at` (raw opens — inflated by mail scanners). The first POST of any kind sets `first_interaction_at` (the open metric uses this).
2. If the contact's latest authorization is not `granted`, show the exact authorization text (`core/confirmation/authorization-text.ts`, versioned) with **Grant** / **Decline**. Decline → `authorization_declined`, notification + email to the requester; the page says they cannot confirm and may return to grant later.
3. Items in the request still active at the requested version: kind, short id, statement, quote(s) with source date (or "entered manually"), and a word diff against the previously confirmed version if one exists. Per item: Confirm / Dispute (comment required) / Skip. Items revised since the request show "updated since this request".
4. **Confirm all** → interstitial listing every item being confirmed → explicit submit.
5. Submission: one transaction, one `appendEvents` batch for all responses, carrying a `submission_id` rendered into the form (resubmitting the same form is a no-op).
6. Receipt page + receipt email: items confirmed/disputed with short id, version, content hash, and log head seq/hash.

A contact may change their response on the same link while it is valid; the latest response per contact counts.

### 8.4 Channel-agnostic response
`recordClientResponses({ channel, orgId, engagementId, requestId, contactId, submissionId, responses: [{ itemId, version, contentHash, decision, comment? }], evidence: { ip, userAgent }, clock })` validates authorization, request membership, current version and hash, writes the events, `confirmation_evidence` (with name/email snapshot) and `response_comment`. A future Slack channel calls the same function.

### 8.5 Dispute handling
Dispute → status `disputed`, notification. Member can **revise** (new pending version; prior responses stay in history only) or **withdraw**.

### 8.6 Reminder
`runReminders(now)`: for each link with `email_sent_at`, no `reminder_sent_at`, not revoked/expired, no response from that contact on that request, at least one requested item still pending at the requested version, and `addBusinessDays(email_sent_at, org.reminder_business_days, engagement.time_zone) <= now` → send exactly one reminder, set `reminder_sent_at`. Business days: Mon–Fri in the engagement time zone, no holidays. Triggered by `POST /api/cron/reminders` (bearer `CRON_SECRET`) or `pnpm jobs:run`.

---

## 9. Ingestion and AI extraction

### 9.1 Parsing (`packages/ingest`)
`parseSource({ format, bytes | text }) → { text, rawText, segments: {speaker, start, end}[] }`, normalized per §1.1. `.txt/.md/paste`: text as given. `.vtt`: header, cue ids and timings removed; `<v Name>text</v>` → `Name: text`; multi-line cue text joined with a space. `.srt`: numbers/timings removed, cue lines joined with a space, leading `Name:` kept verbatim. `.docx`: `mammoth.extractRawText`. Speaker labels are kept exactly as written; nothing is inferred. Audio/video and other extensions are rejected (extension and magic bytes). `IngestionAdapter { id; listSources(cursor): AsyncIterable<RawSource> }` is defined with no implementations (notes: Granola enterprise API rather than its MCP server; Slack non-Marketplace apps get 1 channel-history request/min).

### 9.2 Consent policy (`core/domain/consent.ts`, pure)
Default all-party list `CA, CT, DE, FL, IL, MD, MA, MT, NV, NH, OR, PA, WA` (org-configurable). `.vtt` and `.srt` are always `machine_transcript`. `evaluateConsent({ sourceType, allParticipantsConsented, jurisdictions, jurisdictionsKnown }, policy)`:
- not `machine_transcript` → allowed.
- consent attested `true` → allowed.
- not attested and any jurisdiction in the list → **blocked** (`all_party_state_without_consent`; explanation names the states and how to proceed).
- not attested, jurisdictions unknown, `block_unknown_jurisdictions` → **blocked** (`unknown_jurisdiction_without_consent`) (D-013).
The attestation and policy snapshot are stored in `source_ingested`.

### 9.3 Extraction (`packages/ai`)
- `ModelClient { extract(input): Promise<RawCandidate[]> }`. `AnthropicModelClient` uses `@anthropic-ai/sdk`, `ANTHROPIC_MODEL` from env, a forced tool call (`record_candidates`) for structured output, explicit `max_tokens`, and chunking of long sources by segment boundaries.
- Prompts: `packages/ai/prompts/extract.v1.md`; the version string is stored on `extraction_run` and in item provenance.
- Input: source text, source type, existing active items (`short_id, kind, status, statement`) so the model proposes **revisions** (`revises: short_id`) rather than duplicates. Candidate dependencies reference existing short ids or same-run candidates by ordinal (`#3`); on accept, references to accepted candidates resolve to their items and unresolved ones are dropped with a visible note.
- Flow (no transaction held across the model call): tx 1 — check `org.ai_enabled AND engagement.ai_enabled`, create `extraction_run`; if off, throw `AiDisabledError` before any client is constructed or called. Model call outside any transaction. tx 2 — re-check the flags (discard results if AI was switched off meanwhile), verify quotes, insert candidates, finish the run.
- `verifyQuote`: exact `text.slice(start, end) === quote` → `exact`; else nearest exact occurrence of `quote` → offsets corrected, `offset_corrected` (flagged in the UI); else dropped and counted. Empty, whitespace-only or >500-char quotes are dropped.
- AI toggle changes write `audit_log` (`ai.toggle`).
- Eval: `packages/ai/eval` over `fixtures/eval` — 4 synthetic sources with expected items; match = same kind and overlapping span; precision/recall per source and overall. Default: replays recorded responses through the real verification and scoring code; `EVAL_LIVE=1` + `ANTHROPIC_API_KEY` calls the model (D-014).

### 9.4 Review queue and manual entry
Pending candidates grouped by source: Accept, Edit-then-accept (statement, kind, dependencies; span stays as verified), Reject. Accept → `item_created`, or `item_revised` for revision proposals, with `provenance.via = 'ai_candidate'`. Manual entry: kind, statement, optional source + exact quote (server finds and verifies offsets; ambiguous quotes must be lengthened) — or no source, which marks the version `manual: { entered_by }`.

---

## 10. Spec and record export (`packages/export`)

- `renderSpecMarkdown(view, opts)` — from the agreed view (now or `as_of`): header (engagement, generated at, as-of, log head seq + hash, instructions for agents: build only these items, reference ids in commits/PRs), sections Problems / Constraints / Assumptions / Decisions / Requirements; per item `### HALV-R7 · <statement>` with version, content hash, source citation (source date + quote, or "entered manually by <name>"), confirmed by (name or "Erased contact"), confirmation date, depends on, and a **needs review** warning naming the upstream item and cause when flagged. Final section **"Not confirmed — do not build"**: pending, disputed and revision-pending items by short id and statement only. Works as a Spec Kit `spec.md` or a file dropped into a repo.
- **AI-off engagements:** quotes are omitted from the spec export and MCP output (citation = source type, date and offsets), because those outputs are made to be fed to coding agents (D-027).
- `renderRecordMarkdown(record)` / `renderRecordPdf(record)` (pdfkit) — the dispute artifact: agreed record, every confirmation/dispute (contact or "Erased contact", timestamp, version hash, request id, evidence commitment status), the full event list (seq, type, recorded_at, hash), and the `verifyChain` result against `engagement_head`.
- `ExportTarget { id, render(view) → { filename, contentType, body } }` — markdown spec now; Kiro/Cursor rule files later.
- Every export writes `usage_event` + `audit_log`.

## 11. MCP server (`apps/mcp`)

Node `http` server on `MCP_PORT`, `/mcp` via the SDK's Streamable HTTP transport, stateless. `Authorization: Bearer vdt_…` → `auth_resolve_api_token` → org + user; per-token and per-IP rate limits. Read-only tools (ids accept UUID, short code `HALV`, or short id `HALV-R7`):
- `list_engagements()`
- `get_confirmed_spec(engagement_id, as_of?)` → spec markdown (§10)
- `get_item(item_id)` → item with versions, responses, dependencies; unconfirmed items carry `do_not_build: true`
- `list_unconfirmed(engagement_id)` → pending/disputed items (short id + statement)
Each call writes `usage_event(kind='mcp_fetch', tool)`.

## 12. Metrics (`core/domain/metrics.ts`, pure over events + links + usage)

Unit: an **item version sent for confirmation** (in ≥1 `confirmation_requested`); `sent_at` = first such request; `window_end = addBusinessDays(sent_at, 5, engagement tz)`.
- **Matured**: `window_end <= now`, excluding versions the vendor revised, withdrew or superseded before `window_end` with no client response (pulled, not ignored).
- **5-business-day confirmation rate** = matured versions with an `item_confirmed` recorded at or before `window_end` ÷ matured versions. Both numerator and denominator use only matured versions; immature versions are shown as "maturing". Bands: ≥ 50% on target, 25–50% watch, < 25% kill signal.
- **Median time to confirm**: hours from `sent_at` to first `item_confirmed`, over confirmed versions.
- **Dispute rate**: sent versions with ≥1 `item_disputed` ÷ sent versions.
- **Link engagement**: links with `first_interaction_at` ÷ links sent (headline); raw opens (`open_count`, links with `first_opened_at`) shown separately.
- **Requirement churn**: `item_revised` events on items that had a confirmed version before the revision (all kinds, and requirements only).
- **Spec exports**, **MCP fetches** from `usage_event`.
- Per org and per engagement; CSV at `/api/metrics.csv`. Metrics use each engagement's current time zone.

Metering seam: `countActiveEngagements(orgId)` + `EntitlementPolicy` interface; no enforcement.

## 13. Vendor app screens

Engagement list · Engagement ledger (filter by kind, status, needs-review) · Item detail (versions with diffs, sources/quotes, responses, dependencies; revise, withdraw, supersede, add/remove dependency, clear review) · Sources (upload/paste with attestation; view text with highlighted spans; redact) · Review queue · Manual entry · Client contacts (add, erase) · Confirmation requests (create, link status, revoke) · Replay (date picker, known/agreed toggle, diff between two dates, decision context) · Record & spec export · Metrics (org + engagement, CSV) · Notifications · Engagement settings (AI toggle, time zone) · Org settings (admin: AI toggle, retention, all-party states, reminder days, users) · API tokens (per user).

## 14. Security baseline

- Auth: magic link (15-min single-use) → session cookie (`HttpOnly`, `Secure` in prod, `SameSite=Lax`). Roles `admin`/`member`; admin-only: org settings, users, org AI toggle, retention.
- Audit log actions: `auth.login`, `auth.logout`, `source.ingest`, `source.redact`, `ai.toggle`, `engagement.create`, `engagement.update`, `confirmation.request`, `confirmation.revoke`, `export.spec`, `export.record_md`, `export.record_pdf`, `contact.erase`, `user.invite`, `user.deactivate`, `api_token.create`, `api_token.revoke`, `settings.update`.
- Rate limits (Postgres fixed window, `core/security/rate-limit.ts`): client pages per IP and per link, magic-link requests per IP and per email, MCP per token and per IP.
- Logging: `core/log.ts` accepts ids, enums and counts only. Never source text, statements, quotes, comments, emails, names, IPs or tokens. DB errors logged by SQLSTATE and constraint name only.
- No customer data is used to train or fine-tune anything. AI-off is enforced server-side.
- Secrets only via env (`SESSION_SECRET`, `LINK_SIGNING_SECRET`, `CRON_SECRET`, `ANTHROPIC_API_KEY`).

## 15. Extension seams

| seam | interface | location |
|---|---|---|
| ingestion adapters | `IngestionAdapter` | `packages/ingest/src/adapter.ts` |
| confirmation channels | `ConfirmationChannel` + `recordClientResponses` | `packages/core/src/confirmation/` |
| export targets | `ExportTarget` | `packages/export/src/target.ts` |
| email | `EmailProvider` | `packages/email` |
| model providers | `ModelClient` | `packages/ai/src/model-client.ts` |
| metering | `countActiveEngagements`, `EntitlementPolicy` | `packages/core/src/metering.ts` |
| projection snapshots / diff writer | `loadState`, `writeProjections` | `packages/core/src/store/` |

## 16. Testing

- Unit (pure): canonical JSON, hashing, reducer, replay, diff, dependencies, consent, parsers, quote verification, business days, metrics, word diff, markdown export.
- Integration (Vitest, real Postgres `veradact_test` as `veradact_app`, files `*.int.test.ts`): append-only enforcement, hash-chain tamper and truncation detection, hash round-trip, RLS catalog sweep + cross-tenant read/write, version-bound confirmations, sourced-or-manual, bitemporal fields, rebuild == live (property test, 1,000 events), AI-off zero model calls, consent blocking, erasure keeps the chain valid.
- E2E (Playwright): full confirmation flow incl. expired/revoked links.
- Eval: extraction precision/recall.

## 17. Deployment (pilot)

Any Node 22 host for `apps/web` and `apps/mcp` plus managed Postgres 16. Production email through any SMTP provider (`SMTP_URL`). A scheduler (platform cron or similar) calls `/api/cron/reminders` hourly and `/api/cron/retention` daily with `CRON_SECRET`. No vendor-specific deployment code in the MVP.
