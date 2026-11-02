# Veradact — Architecture

Veradact proves what a client agreed to. Each engagement is an append-only, hash-chained event log in Postgres. Current state is a projection of that log, replay is a fold of the log up to a point in time, and only client-confirmed item versions flow into specs for coding agents.

Product spec: [`docs/SPEC.md`](docs/SPEC.md). Decision log: [`DECISIONS.md`](DECISIONS.md). Working conventions: [`CLAUDE.md`](CLAUDE.md).

---

## 1. System overview

```
                ┌──────────────────────── apps/web (Next.js 15, App Router) ───────────────────────┐
 vendor user ──▶│ /login, /engagements/**, /metrics, /settings     (session cookie, RLS tenant ctx)  │
 client     ──▶ │ /c/[token]   plain, no JS required, no third-party assets, no-referrer             │
 cron       ──▶ │ /api/cron/reminders, /api/cron/retention          (CRON_SECRET)                    │
                └───────────────┬───────────────────────────────────────────────────────────────────┘
                                │ calls services
 coding agent ─▶ apps/mcp (Node http, MCP SDK Streamable HTTP, bearer API token) ─┐
                                ▼                                                 ▼
          packages/core  — domain (pure): events, canonical JSON + hashing, reducer, replay, diff,
                           dependencies, business days, metrics, consent policy
                         — services (DB): append API, commands, queries, confirmation, auth, jobs
          packages/db    — Drizzle schema, SQL migrations (roles, RLS, triggers), tenant-scoped client
          packages/ingest— parsers (.txt .md .vtt .srt .docx), IngestionAdapter interface
          packages/ai    — ModelClient (Anthropic SDK), versioned prompts, quote verification, eval
          packages/export— spec markdown, record markdown + PDF, ExportTarget interface
          packages/email — EmailProvider: console | smtp (Mailpit in dev) | memory (tests)
                                ▼
                       Postgres 16 (docker compose, port 54330) · Mailpit (54331 smtp / 54332 ui)
```

Dependency direction: `apps/* → core → db`; `core → ingest, ai, email`; `export → core (types only)`. `core/domain` imports nothing that does IO. Packages are consumed as TypeScript source (no build step); Next uses `transpilePackages`, the MCP server runs on `tsx`.

---

## 2. Data model

All tenant tables carry `org_id uuid not null` and have RLS enabled (§7). Timestamps are `timestamp(3) with time zone` so values round-trip exactly through JavaScript `Date` (required for hashing, §4). IDs are UUIDv4 generated in the application unless noted.

### 2.1 Tenancy and identity (mutable, operational)

| table | key columns | notes |
|---|---|---|
| `org` | `id, name, slug, ai_enabled bool=true, retention_days int null, all_party_states text[]` (default list §9.2), `block_unknown_jurisdictions bool=true, reminder_business_days int=2, created_at` | RLS: `id = current org` |
| `app_user` | `id, org_id, email citext unique, name, role ('admin'\|'member'), deactivated_at, created_at` | one org per user in MVP; email globally unique |
| `login_token` | `id, org_id, user_id, token_hash, expires_at (15 min), used_at` | magic link, single use |
| `session` | `id, org_id, user_id, token_hash unique, expires_at (30 d), revoked_at, last_seen_at` | cookie `vd_session` holds the raw token |
| `api_token` | `id, org_id, user_id, name, token_prefix, token_hash unique, last_used_at, revoked_at` | MCP bearer tokens `vdt_<base64url>` |
| `engagement` | `id, org_id, name, client_name, short_code (A–Z0–9, 2–8, unique per org), time_zone (IANA), ai_enabled bool=true, status ('active'\|'archived'), created_by, created_at, archived_at` | `status='active'` is the metering unit (§12) |
| `client_contact` | `id, org_id, engagement_id, created_at, erased_at` | **no PII here**; the id is the subject id used in events |
| `contact_pii` | `contact_id pk, org_id, name, email, title, hmac_key bytea(32)` | erasable (§6) |

Raw secrets are never stored: `*_hash = sha256(raw token)`.

### 2.2 The log

`event` — append-only, hash-chained per engagement.

| column | type | notes |
|---|---|---|
| `id` | `bigint generated always as identity` | global insert order, not semantic |
| `org_id, engagement_id` | uuid | |
| `seq` | bigint | 1..n per engagement, `unique(engagement_id, seq)` |
| `type` | text | §3 |
| `schema_version` | smallint | payload schema version, starts at 1 |
| `payload` | jsonb | validated by zod per type; **never contains PII or source text** (§6) |
| `actor_type, actor_id` | text, uuid null | `user` (app_user id), `contact` (client_contact id), `system` |
| `occurred_at` | timestamptz(3) | when it was said / happened in the world |
| `recorded_at` | timestamptz(3) | when it entered the ledger; monotonic non-decreasing per engagement |
| `prev_hash, hash` | char(64) | §4 |

Database enforcement (migration SQL):
- `REVOKE UPDATE, DELETE, TRUNCATE ON event FROM veradact_app`; app role gets `SELECT, INSERT` only.
- `BEFORE UPDATE OR DELETE` row trigger and `BEFORE TRUNCATE` statement trigger raise `event log is append-only` (blocks every role unless the trigger is explicitly disabled by the owner — tests use this to simulate tampering).
- `BEFORE INSERT` trigger checks `seq = last_seq + 1` and `prev_hash = last_hash` (genesis: `seq = 1`, `prev_hash = 64×'0'`). Hash *content* is computed and verified in TypeScript (§4); the trigger guarantees linkage.

### 2.3 Projections (rebuildable from the log — §5)

| table | key columns |
|---|---|
| `source` | `id, org_id, engagement_id, title, source_type, format, filename, occurred_at, recorded_at, content_sha256, char_length, participant_count, attestation jsonb, ingested_by, redacted_at, redaction_reason` |
| `item` | `id, org_id, engagement_id, short_id (unique per engagement), kind, current_version, status ('pending'\|'confirmed'\|'disputed'), lifecycle ('active'\|'superseded'\|'withdrawn'), superseded_by, needs_review bool, review_reasons jsonb, created_at, updated_at, last_seq` |
| `item_version` | `item_id, version (pk pair), org_id, engagement_id, content_hash, statement, spans jsonb, manual jsonb null, provenance jsonb, revision_reason, occurred_at, recorded_at, event_seq` |
| `item_dependency` | `org_id, engagement_id, item_id, depends_on_item_id, added_seq` |
| `item_response` | `org_id, engagement_id, event_seq, item_id, version, content_hash, contact_id, request_id, response ('confirmed'\|'disputed'), comment_commitment null, recorded_at` |
| `confirmation_request` | `id, org_id, engagement_id, requested_by, expires_at, recorded_at, event_seq` |
| `confirmation_request_item` | `request_id, item_id, version, content_hash` |
| `confirmation_request_contact` | `request_id, contact_id, revoked_at null` |
| `contact_authorization` | `org_id, engagement_id, contact_id, request_id, decision ('granted'\|'declined'), text_version, text_sha256, recorded_at, event_seq` (latest row per contact wins) |

### 2.4 Operational tables (mutable, outside the log)

| table | purpose |
|---|---|
| `source_content` | `source_id pk, org_id, engagement_id, text` (normalized, offsets refer to this), `raw_text, participants jsonb` (as given), `segments jsonb` (`[{speaker, start, end}]`), `hmac_key bytea(32)`. Deleted on redaction. |
| `extraction_run` | `id, org_id, engagement_id, source_id, model, prompt_version, status, proposed_count, dropped_count, corrected_count, error_code, created_at, finished_at` — ids and counts only |
| `candidate` | review queue: `id, org_id, engagement_id, source_id, extraction_run_id, kind, statement, quote, start, end, speaker_label, suggested_depends_on jsonb (short ids), confidence numeric, revises_item_id null, verification ('exact'\|'offset_corrected'), status ('pending'\|'accepted'\|'rejected'), decided_by, decided_at, resulting_item_id` |
| `confirmation_link` | `id, org_id, engagement_id, request_id, contact_id, expires_at, revoked_at, email_sent_at, reminder_sent_at, first_opened_at, last_opened_at, open_count` |
| `confirmation_evidence` | `event_id pk → event.id, org_id, contact_id, ip, user_agent` — erasable |
| `response_comment` | `event_id pk → event.id, org_id, contact_id, comment` — erasable |
| `notification` | `id, org_id, user_id, engagement_id, kind ('item_disputed'\|'authorization_declined'), item_id null, contact_id null, read_at, created_at` |
| `usage_event` | `id, org_id, engagement_id, kind ('spec_export'\|'record_export_md'\|'record_export_pdf'\|'mcp_fetch'), user_id, api_token_id, tool, created_at` |
| `audit_log` | `id, org_id, actor_user_id, action, target_type, target_id, metadata jsonb (ids/enums only), created_at` — app role `SELECT, INSERT` only |
| `rate_limit_bucket` | `key (sha256), window_start, count` — no tenant data, no RLS |

---

## 3. Event types (schema_version 1)

Payloads are zod schemas in `packages/core/src/domain/events.ts`. `Span = { source_id, start, end, quote_commitment }` where `quote_commitment = HMAC-SHA256(source_content.hmac_key, quote)` (hex). The quote text itself is **not** in the log; it is read from `source_content.text.slice(start, end)` at view time and re-verified against the commitment.

| type | payload | notes |
|---|---|---|
| `engagement_created` | `engagement_id, short_code, name, client_name, time_zone` | always seq 1 (genesis) |
| `source_ingested` | `source_id, title, source_type ('human_notes'\|'machine_transcript'\|'email'\|'chat_export'), format ('txt'\|'md'\|'vtt'\|'srt'\|'docx'\|'paste'), filename, content_sha256, char_length, participant_count, attestation` | `occurred_at` = source date. `attestation = { attested_by, source_type, all_participants_consented: bool\|null, participant_jurisdictions: string[], jurisdictions_known: bool, policy: { version, all_party_states, block_unknown_jurisdictions }, decision: 'allowed', rule }` |
| `source_redacted` | `source_id, reason ('user_request'\|'retention'\|'consent_withdrawn'\|'other')` | tombstone; content row deleted in same tx |
| `item_created` | `item_id, short_id, kind, version: 1, statement, spans: Span[], manual: {entered_by} \| null, depends_on: item_id[], provenance: { via: 'manual'\|'ai_candidate', candidate_id?, model?, prompt_version?, edited? }, content_hash` | replaces spec's `item_proposed` + `item_accepted` (D-004) |
| `item_revised` | `item_id, version (n+1), statement, spans, manual, provenance, reason, content_hash, previous_content_hash` | kind is immutable (it is encoded in the short id) |
| `item_superseded` | `item_id, superseded_by_item_id, reason` | |
| `item_withdrawn` | `item_id, reason` | |
| `dependency_added` / `dependency_removed` | `item_id, depends_on_item_id` | dependents must be `decision` or `requirement`; no self-edges, no cycles |
| `review_cleared` | `item_id` | member acknowledges a needs-review flag |
| `confirmation_requested` | `request_id, items: [{item_id, version, content_hash}], contact_ids, expires_at, channel: 'email_link'` | |
| `confirmation_revoked` | `request_id, contact_id \| null` (null = all contacts) | |
| `authorization_granted` / `authorization_declined` | `contact_id, request_id, text_version, text, text_sha256, evidence_commitment` | `text` is the exact rendered authorization text (vendor + engagement names, no PII) |
| `item_confirmed` | `item_id, version, content_hash, contact_id, request_id, channel, evidence_commitment` | |
| `item_disputed` | `item_id, version, content_hash, contact_id, request_id, channel, evidence_commitment, comment_commitment` | comment text lives in `response_comment` |
| `contact_erased` | `contact_id` | marks erasure in the record (§6) |

`content_hash = sha256(canonical({ engagement_id, item_id, kind, version, statement, spans, manual }))`. Version and item id are included, so a confirmation of v1 can never match v3 even if the text is identical. Dependencies are not part of confirmed content.

Short ids: `<SHORT_CODE>-<K><n>` with K ∈ {P problem, C constraint, A assumption, D decision, R requirement} and n = 1 + count of existing items of that kind, allocated at command time under the engagement lock and **stored in the payload**, so projection stays pure and ids never change.

---

## 4. Hash chain

```
hash = sha256_hex(canonical({
  v: 1, org_id, engagement_id, seq, type, schema_version,
  payload, actor: { type, id }, occurred_at, recorded_at, prev_hash
}))
```
- `canonical()` = JSON with recursively sorted object keys, no whitespace, arrays in order, `undefined` forbidden, numbers must be finite integers or safe decimals, dates as `toISOString()` (ms precision, UTC). Implemented in-house (~30 lines, D-008).
- Genesis `prev_hash` = 64 zeros.
- `recorded_at = max(now(), head.recorded_at)` so recorded time never goes backwards within an engagement; replay by `recorded_at` and by `seq` therefore agree.
- `verifyChain(events) → { ok, checked, headSeq, headHash, firstBadSeq?, reason?: 'seq_gap'|'prev_hash_mismatch'|'hash_mismatch' }` recomputes every hash from row contents. Exports include the result and the head hash.
- External anchoring: the client's confirmation receipt email (§8.6) contains the item version hashes and the log head hash at submission time, so the client holds an independent copy that a rewritten chain would contradict.

---

## 5. Projection, append and replay

### 5.1 One reducer
`reduce(state: EngagementState, event: StoredEvent) → EngagementState` in `core/domain/reducer.ts` is the **only** projection logic. It is pure, total (never throws on a well-formed event; invalid transitions are rejected earlier by commands), and deterministic.

```ts
EngagementState = {
  engagement: { id, orgId, shortCode, name, clientName, timeZone }
  headSeq, headHash, headRecordedAt
  sources:  Map<id, { id, title, sourceType, format, filename, occurredAt, recordedAt, contentSha256, charLength, participantCount, attestation, ingestedBy, redacted: {at, reason} | null }>
  items:    Map<id, { id, shortId, kind, versions: ItemVersion[], currentVersion, lifecycle, supersededBy, dependsOn: Set<id>, needsReview, reviewReasons: {upstreamItemId, cause, seq}[], responses: Response[], createdAt, updatedAt, lastSeq }>
  requests: Map<id, { id, items: {itemId, version, contentHash}[], contactIds, revokedContactIds: Set, revokedAll, expiresAt, requestedBy, recordedAt, seq }>
  authorizations: Map<contactId, { decision, requestId, textVersion, textSha256, at, seq }>
  erasedContacts: Set<contactId>
  kindCounters: Record<Kind, number>
}
```

Status is derived, not stored independently: for the current version, take the latest response per contact; any `disputed` → `disputed`; else any `confirmed` → `confirmed`; else `pending`. Responses recorded against a non-current version stay in history but never affect status (this is what makes confirmations version-bound).

Needs-review: on `item_revised`, `item_superseded`, `item_withdrawn`, or `item_disputed` of the current version of upstream U, every direct dependent D of U gets `needsReview = true` and a reason entry. Cleared by `item_revised` of D or `review_cleared` of D. Direct dependents only (D-011).

### 5.2 Append API (live path)
`appendEvents(tx, engagementId, drafts)` in `core/store/append.ts`:
1. `pg_advisory_xact_lock(hashtextextended(engagement_id::text, 0))` — serializes writers per engagement.
2. Load state by folding the engagement's log (D-006; snapshotting is a later optimization behind the same function).
3. For each draft: assign `seq`, `recorded_at`, `prev_hash`; compute `hash`; insert; `next = reduce(state, stored)`.
4. Write projection rows for entities that changed between `state` and `next` (`core/store/projection-writer.ts`).
5. Commit with whatever operational writes the command made (same transaction).

Commands (`core/commands/*`) validate against the loaded state *before* producing drafts: item exists and is active, version/hash match, contact authorized, request includes the item version and is unexpired/unrevoked, dependency rules, span verification against `source_content`, AI-off, consent policy.

### 5.3 Rebuild path
`rebuildProjections(tx, engagementId)`: delete projection rows for the engagement, fold the full log from `emptyState()`, write every row with the same projection writer. Invariant test: after N random commands through the live path, a canonical dump of all projection tables equals the dump after rebuild, and equals `projectRows(fold(events))` computed purely (property test, 1,000 events, fast-check).

### 5.4 Replay
All replay functions are pure over `StoredEvent[]` (loaded once per request):
- `asOf(events, T, 'known')` = `fold(events.filter(e => e.recordedAt <= T))` → every item and every version recorded by T with status, lifecycle and needs-review as of T.
- `asOf(events, T, 'agreed')` = items whose status at T is `confirmed` and lifecycle `active`, at the confirmed (current) version, with confirmers and dates. Also returns `previouslyAgreed`: items with an earlier confirmed version whose current version at T is pending or disputed — context, never part of the agreed set (D-010).
- `diff(events, T1, T2)` = per item compare of `asOf(T1)` vs `asOf(T2)` plus the event list in `(T1, T2]`: `added`, `revised (fromVersion → toVersion)`, `confirmed`, `disputed`, `superseded`, `withdrawn`.
- `decisionContext(events, itemId, version?)` = `asOf(known)` at that version's `recorded_at`, plus each dependency of X with its status and version at that instant.

---

## 6. Personal data and redaction (erasure without breaking the chain)

Rule: **anything that identifies or was authored by a client contact, and all source text, lives outside the log. The log stores opaque ids and keyed commitments.** Erasure deletes the off-log rows and the keys; event rows are untouched, so the chain still verifies.

| data | where | commitment in log | erased by |
|---|---|---|---|
| contact name, email, title | `contact_pii` | — (events use `contact_id`) | contact erasure |
| confirmation IP + user agent | `confirmation_evidence` | `evidence_commitment = HMAC(contact key, canonical{name, email, ip, user_agent})` | contact erasure |
| dispute comment | `response_comment` | `comment_commitment = HMAC(contact key, comment)` | contact erasure |
| source text, participants, speaker labels | `source_content` | `content_sha256` (whole text), `quote_commitment = HMAC(source key, quote)` | source redaction / retention |
| item statement | event payload | — | not erasable: it is the vendor-authored agreement text; the UI warns members not to put personal data in statements (D-012) |

- `eraseContact(contactId)`: delete `contact_pii` (and its HMAC key), `confirmation_evidence` and `response_comment` rows for the contact, set `client_contact.erased_at`, revoke the contact's links, append `contact_erased`, write `audit_log`. Commitments in the log become unlinkable random values. Exports render "Erased contact".
- `redactSource(sourceId, reason)`: delete `source_content` (text, participants, segments, key) and pending candidates from that source, append `source_redacted`, audit. Item versions keep their spans and commitments (so confirmations stay valid); the UI shows "source redacted on <date>" instead of the quote.
- Vendor users: deactivation anonymizes `app_user.email/name`; events reference user ids only.
- Retention: `org.retention_days` → nightly job redacts sources older than the window (`reason: 'retention'`) and deletes their candidates.

---

## 7. Tenant isolation

- Roles: `veradact_admin` owns all objects and runs migrations/seed. `veradact_app` (`NOSUPERUSER NOBYPASSRLS`) is the only role the apps use (`DATABASE_URL`).
- Every tenant table: `ENABLE ROW LEVEL SECURITY` + policy `USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org())`, where `app_current_org()` = `nullif(current_setting('app.org_id', true), '')::uuid`. No setting → no rows.
- `withTenant(db, { orgId, userId }, fn)` opens a transaction and runs `select set_config('app.org_id', $1, true)` (transaction-local), then `fn(tx)`. All tenant data access goes through it; there is no other way to obtain a tenant-scoped handle.
- Pre-tenant lookups use narrow `SECURITY DEFINER` functions owned by `veradact_admin`, `search_path` pinned, `EXECUTE` granted to `veradact_app`, each returning only ids:
  `auth_find_user_by_email(email)`, `auth_resolve_login_token(hash)`, `auth_resolve_session(hash)`, `auth_resolve_api_token(hash)`, `link_resolve(link_id)`, `jobs_list_org_ids()`.
- Jobs iterate `jobs_list_org_ids()` and do all work per org inside `withTenant`.
- Tests: for each tenant table, a session scoped to org A cannot select, insert, update or delete org B rows (and `insert ... org_id = B` fails `WITH CHECK`).

---

## 8. Client confirmation

### 8.1 Request
Member selects pending/revised items + contacts → `requestConfirmation` validates items are active and pending/disputed at their current version → appends `confirmation_requested` → creates one `confirmation_link` per contact (default expiry 14 days) → delivers via `ConfirmationChannel` (`email_link` implementation) → audit.

### 8.2 Link token (signed, expiring, revocable, contact-bound)
`v1.<link_id>.<exp_unix>.<sig>` where `sig = base64url(HMAC-SHA256(LINK_SIGNING_SECRET, "v1|link_id|contact_id|exp"))`. Validation: parse → `link_resolve(link_id)` (security definer, returns org/engagement/request/contact/expiry/revocation) → constant-time signature check with the resolved contact id → `exp` and `expires_at` in the future → not revoked (link row and `confirmation_revoked` state). Any failure renders the same plain "This link is no longer valid" page (HTTP 410), revealing nothing.

### 8.3 Client page `/c/[token]`
Server-rendered HTML forms that work without JavaScript; mobile-first plain CSS; no third-party resources, analytics or fonts. Headers: `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`, strict CSP (`default-src 'self'`), `Cache-Control: no-store`.
1. First open → record open (`first_opened_at`, `open_count`).
2. If the contact has no `granted` authorization (latest decision), show the exact authorization text (versioned in `core/confirmation/authorization-text.ts`) with **Grant** / **Decline**. Decline → `authorization_declined`, in-app notification + email to the requester; page explains they cannot confirm and can revisit the link to grant later.
3. Items in the request that are still active at the requested version: kind, short id, statement, quote(s) with source title and date (or "entered manually"), and a word diff against the previously confirmed version if one exists. Per item: Confirm / Dispute (comment required) / Skip. Items revised since the request show "updated since this request — ask the sender for a new link".
4. **Confirm all** → interstitial listing every item being confirmed → explicit submit.
5. Submission → for each non-skipped item: `recordClientResponse` (channel-agnostic, §8.4). Disputes notify the requester.
6. Receipt page + receipt email: items confirmed/disputed with short id, version and content hash, plus log head seq/hash.

### 8.4 Channel-agnostic response
`recordClientResponse({ channel: 'web_link' | …, orgId, engagementId, requestId, contactId, itemId, version, contentHash, decision: 'confirmed'|'disputed', comment?, evidence: { ip, userAgent } })` — validates authorization, request membership, current version and hash; writes the event, `confirmation_evidence`, `response_comment`. A future Slack channel calls the same function.

### 8.5 Dispute handling
Dispute → item status `disputed`, notification. Member can **revise** (new version, status `pending`, previous responses remain in history only) or **withdraw**.

### 8.6 Reminder
`runReminders(now)`: for each link with `email_sent_at`, no `reminder_sent_at`, not revoked/expired, no response from that contact on that request, at least one requested item still pending at the requested version, and `addBusinessDays(email_sent_at, org.reminder_business_days, engagement.time_zone) <= now` → send one reminder, set `reminder_sent_at`. Business days = Mon–Fri in the engagement time zone (no holiday calendar in MVP). Triggered by `POST /api/cron/reminders` (bearer `CRON_SECRET`) or `pnpm jobs:run`.

---

## 9. Ingestion and AI extraction

### 9.1 Parsing (`packages/ingest`)
`parseSource({ format, bytes | text }) → { text, rawText, segments: {speaker, start, end}[] }`. `.txt/.md/paste`: text as given (normalized line endings). `.vtt/.srt`: cue timing and numbering removed; speaker taken verbatim from `<v Name>` or a leading `Name:`; rendered `Name: utterance` lines. `.docx`: `mammoth.extractRawText`. Audio/video and any other extension are rejected by extension and MIME sniffing. Offsets always refer to `text`. `IngestionAdapter { id; listSources(cursor): AsyncIterable<RawSource> }` defined, no implementations (notes: Granola enterprise API, not MCP; Slack non-Marketplace apps get 1 channel-history request/min).

### 9.2 Consent policy (`core/domain/consent.ts`, pure)
Default all-party list: `CA, CT, DE, FL, IL, MD, MA, MT, NV, NH, OR, PA, WA` (org-configurable). `evaluateConsent({ sourceType, allParticipantsConsented, jurisdictions, jurisdictionsKnown }, policy)`:
- non-`machine_transcript` → allowed.
- machine transcript and consent attested (`true`) → allowed.
- machine transcript, not attested, and any jurisdiction in the all-party list → **blocked** (`rule: 'all_party_state_without_consent'`, explanation names the states).
- machine transcript, not attested, jurisdictions unknown and `block_unknown_jurisdictions` → **blocked** (`rule: 'unknown_jurisdiction_without_consent'`) (D-013).
The attestation and policy snapshot are stored in `source_ingested`.

### 9.3 Extraction (`packages/ai`)
- `ModelClient { extract(input): Promise<RawCandidate[]> }`; `AnthropicModelClient` uses `@anthropic-ai/sdk` with `ANTHROPIC_MODEL` from env and a forced tool call (`record_candidates`, JSON schema) for structured output.
- Prompts are versioned files `packages/ai/prompts/extract.v1.md`; the version string is recorded on `extraction_run` and in item provenance.
- Input: source text, source type, existing active items (`short_id, kind, status, statement`) so the model can propose **revisions** (`revises: short_id`) instead of duplicates.
- Verification (`verifyQuote`): exact `text.slice(start, end) === quote` → `exact`; else unique/nearest exact occurrence of `quote` in `text` → offsets corrected, `offset_corrected` (shown as a flag); else **dropped** and counted. Empty, >500-char, or whitespace-only quotes are dropped. Unsourced candidates never reach the queue.
- AI-off: `extractCandidates()` reads `org.ai_enabled AND engagement.ai_enabled` inside the tenant transaction and throws `AiDisabledError` before any client is constructed or called. Toggle changes write `audit_log` (`ai.toggle`).
- Eval: `packages/ai/eval/` — 4 synthetic transcripts with expected items; matcher = same kind and overlapping quote span; reports precision/recall per transcript and overall. Runs in Vitest against recorded model responses by default; against the live API when `ANTHROPIC_API_KEY` and `EVAL_LIVE=1` are set (D-014).

### 9.4 Review queue
Pending candidates grouped by source; Accept, Edit-then-accept (statement, kind, dependencies; the span stays as verified), Reject. Accept → `item_created` (or `item_revised` for revision proposals) with `provenance.via = 'ai_candidate'`. Manual entry: kind, statement, optional source + exact quote (server finds and verifies offsets) — or none, which marks the version `manual: { entered_by }`.

---

## 10. Spec and record export (`packages/export`)

- `renderSpecMarkdown(view)` — from the agreed view (now or `as_of`): header (engagement, generated at, as-of, log head seq + hash, agent instructions: build only these items, cite ids in commits/PRs), sections Problems / Constraints / Assumptions / Decisions / Requirements; each item `### ACME-R7 · <statement>` with version, content hash, source citation (source title, date, quote — or "entered manually by <name>"), confirmed by (name or "Erased contact"), confirmation date, depends on. Final section **"Not confirmed — do not build"**: pending and disputed items by short id and statement only. Compatible with Spec Kit (`spec.md`) and as a file dropped into a repo.
- `renderRecordMarkdown(record)` / `renderRecordPdf(record)` (pdfkit) — dispute artifact: confirmed record with confirmations (contact, timestamp, version hash, request id), the full event list with seq/type/recorded_at/hash, and the `verifyChain` result.
- `ExportTarget { id, render(view) → { filename, contentType, body } }` — markdown spec now; Kiro/Cursor rule files later.
- Every export writes `usage_event` + `audit_log`.

## 11. MCP server (`apps/mcp`)

Node `http` server on `MCP_PORT`, `POST/GET/DELETE /mcp` via the SDK's Streamable HTTP transport in stateless mode. `Authorization: Bearer vdt_…` → `auth_resolve_api_token` → org + user; per-token and per-IP rate limits. Read-only tools (ids accept UUID or short id/short code):
- `list_engagements()`
- `get_confirmed_spec(engagement_id, as_of?)` → spec markdown
- `get_item(item_id)` → item with versions, responses, dependencies
- `list_unconfirmed(engagement_id)` → pending/disputed items (id + statement)
Each call writes `usage_event(kind='mcp_fetch', tool)`.

## 12. Metrics (`core/domain/metrics.ts`, pure over events + links + usage)

Unit: an **item version sent for confirmation** (appears in ≥1 `confirmation_requested`); `sent_at` = first such request.
- **5-business-day confirmation rate** = sent versions confirmed within 5 business days (engagement TZ) of `sent_at` ÷ matured sent versions (`sent_at + 5bd ≤ now`). Versions the vendor revised/withdrew/superseded before any client response and before the window closed are excluded (pulled, not ignored). Bands: ≥ 50% on target, 25–50% watch, < 25% kill signal.
- **Median time to confirm** (hours, first confirmation − `sent_at`), **dispute rate** (sent versions with ≥1 dispute ÷ sent versions), **link open rate** (links opened ≥1 ÷ links sent, plus total opens).
- **Requirement churn** = `item_revised` events on items that had a confirmed version before the revision (all kinds and requirements only).
- **Spec exports** and **MCP fetches** from `usage_event`.
- Per org and per engagement; CSV at `/api/metrics.csv`.

Metering seam: `countActiveEngagements(orgId)` and an `EntitlementPolicy` interface; no enforcement.

## 13. Security baseline

- Auth: magic link (15-min single-use token) → session cookie (`HttpOnly; Secure` in prod; `SameSite=Lax`). Roles `admin`/`member`; admin-only: org settings, users, org-level AI toggle, retention.
- Audit log actions: `auth.login`, `auth.logout`, `source.ingest`, `source.redact`, `ai.toggle`, `engagement.create`, `engagement.update`, `confirmation.request`, `confirmation.revoke`, `export.spec`, `export.record_md`, `export.record_pdf`, `contact.erase`, `user.invite`, `user.deactivate`, `api_token.create`, `api_token.revoke`, `settings.update`.
- Rate limits (Postgres fixed window, `core/security/rate-limit.ts`): client pages per IP and per link, magic-link requests per IP and per email, MCP per token and per IP.
- Logging: `core/log.ts` accepts only ids, enums and counts. No source text, statements, quotes, comments, emails, names, IPs or tokens in logs or error reports. DB errors are logged by code and constraint name only.
- No customer data is used to train or fine-tune anything. AI-off is enforced server-side.
- Secrets only via env (`SESSION_SECRET`, `LINK_SIGNING_SECRET`, `CRON_SECRET`, `ANTHROPIC_API_KEY`).

## 14. Extension seams

| seam | interface | location |
|---|---|---|
| ingestion adapters | `IngestionAdapter` | `packages/ingest/src/adapter.ts` |
| confirmation channels | `ConfirmationChannel` + `recordClientResponse` | `packages/core/src/confirmation/` |
| export targets | `ExportTarget` | `packages/export/src/target.ts` |
| email | `EmailProvider` | `packages/email` |
| model providers | `ModelClient` | `packages/ai/src/model-client.ts` |
| metering | `countActiveEngagements`, `EntitlementPolicy` | `packages/core/src/metering.ts` |
| projection snapshots | `loadState` | `packages/core/src/store/load-state.ts` |

## 15. Testing

- Unit (pure): canonical JSON, hashing, reducer, replay, diff, dependencies, consent, parsers, quote verification, business days, metrics, word diff, markdown export.
- Integration (Vitest, real Postgres `veradact_test` as `veradact_app`): append-only enforcement, hash-chain tamper detection, RLS cross-tenant read/write, version-bound confirmations, manual-or-sourced invariant, bitemporal fields, rebuild == live (property test, 1,000 events), AI-off zero model calls, consent blocking, erasure keeps the chain valid.
- E2E (Playwright): full confirmation flow incl. expired/revoked links.
- Eval: extraction precision/recall.
