# Decisions

Running log. Newest decisions are appended at the bottom. Each entry: what we decided, why, and what it costs. Entries marked **[spec deviation]** change or tighten something in [`docs/SPEC.md`](docs/SPEC.md) and are worth a product review.

---

### D-001 · Name
The product is **Veradact**. The spec's working name "Deployment Ledger" survives only in `docs/SPEC.md`.

### D-002 · Phases run back to back **[spec deviation: process]**
The spec asks to stop for approval after each phase. The owner asked for the whole MVP in one pass without questions. Each phase still ends with tests, lint, typecheck and a commit; questions that would have been asked are recorded here as decisions so they can be revisited.

### D-003 · Stack details
Next.js **15** App Router (stable, well-understood APIs; 16 renamed middleware and changed caching defaults with little benefit for us). `postgres` (postgres.js) driver under Drizzle. Tailwind v4 for the vendor app only; the client page uses a small hand-written stylesheet so it stays plain and asset-free. Packages are consumed as TypeScript source, no build step.

### D-004 · AI candidates live outside the log; `item_created` replaces `item_proposed` + `item_accepted` **[spec deviation]**
The spec lists `item_proposed` and `item_accepted` as events. We keep AI candidates in a mutable `candidate` table (the review queue) and write a single `item_created` event when a human accepts or enters an item.
Why: the log is the dispute artifact, and the spec says nothing enters the ledger without a human accept. Putting machine guesses (most of which get rejected) into a tamper-evident record weakens it, and candidates contain quote text that must stay redactable. Provenance (`via: ai_candidate`, candidate id, model, prompt version, edited flag) is kept on the event, so the audit question "did a human change what the AI proposed?" is still answerable.

### D-005 · MCP server is its own app
`apps/mcp` is a plain Node `http` server using the MCP SDK's Streamable HTTP transport (stateless). The SDK transport expects Node request/response objects, and a separate process lets us rate limit and scale agent traffic independently of the vendor UI. It shares `core`, `db` and `export` with the web app.

### D-006 · Commands load state by folding the log
Each command folds the engagement's full event log to get current state, then appends. For pilot-sized engagements (hundreds to low thousands of events) this costs milliseconds and removes an entire class of drift bugs: the live path and the rebuild path run the same reducer from the same input. After each append the engagement's projection rows are deleted and rewritten from the folded state, so "rebuild equals live" holds by construction; the property test guards that property when this is later optimized. Snapshots ("log compaction") and a diffing writer can be added behind `loadState` / `writeProjections` without changing callers.

### D-007 · Hashes computed in TypeScript, linkage enforced in Postgres
Canonicalizing JSON in PL/pgSQL is error-prone, so hashes are computed in the app and re-verified by `verifyChain`. A `BEFORE INSERT` trigger still guarantees `seq` continuity and `prev_hash` linkage, and update/delete/truncate are blocked by both privileges and triggers. Timestamps are stored at millisecond precision (`timestamptz(3)`) so the hashed ISO strings round-trip exactly.

### D-008 · In-house canonical JSON
Sorted-key, whitespace-free JSON is ~30 lines. Not worth a dependency, and we control edge cases (reject `undefined`, non-finite numbers).

### D-009 · Item status with multiple contacts
For the current version, the latest response per contact counts. Any dispute → `disputed`; otherwise any confirmation → `confirmed`; otherwise `pending`. One confirmer is enough, and any confirmer can block. A per-engagement "all contacts must confirm" rule is a later setting.

### D-010 · Meaning of the "agreed" view **[spec clarification]**
The spec says agreed = "only items confirmed as of T, at the version that was confirmed", and also that a confirmation does not carry over to a revision. We read these together as: an item is in the agreed view at T only if its **current version at T** is confirmed. An item that was confirmed at v1 and revised to a pending v2 is *not* agreed; it is returned separately as `previouslyAgreed` for context, and spec export lists it under "Not confirmed — do not build" with a note that a revision is pending. This keeps coding agents from building a version the vendor has already moved away from.

### D-011 · Needs-review flags direct dependents only
Disputing, revising, superseding or withdrawing an upstream item flags its direct dependents. No transitive propagation ("keep this simple"); the flag is visible on the item and in the ledger filters.

### D-012 · Personal data off-log with keyed commitments
Client contact PII, the confirmer's identity/IP/user agent snapshot and dispute comments live in erasable side tables; source text, titles, filenames and participants live in `source_content`; free-text explanations live in `event_note` and the log carries enum reason codes. The log holds contact ids and HMAC commitments keyed per contact — erasure deletes the rows and keys, the commitments become unlinkable, and the hash chain is untouched. This combines the spec's two suggested options (separate tables + destroyable per-subject keys). Quotes need no commitment of their own: a span stores `source_id, source_sha256, start, end`, which binds the exact quoted text through the source's content hash.
Cost: item **statements** stay in the log because they are the vendor-authored agreement itself. Members are warned in the UI not to put personal data in statements. Dispute comments are erased along with the contact, which loses the client's stated reason for that dispute (the dispute event itself remains).

### D-013 · Unknown jurisdictions block unattested machine transcripts **[spec deviation: stricter]**
The spec blocks an unattested machine transcript only when a participant is known to be in an all-party-consent state. If jurisdictions are unknown, that rule silently allows the riskiest case. Default: unknown jurisdictions are treated like an all-party state (org setting `block_unknown_jurisdictions`, default on). The uploader can always proceed by attesting that all participants consented, which they should be able to do for any legitimately recorded call. Human-written notes, emails and chat exports are always allowed, as specified.

### D-014 · Extraction eval runs on recorded responses by default
The eval is a Vitest test. By default it replays recorded model responses so CI is deterministic and needs no API key; with `EVAL_LIVE=1` and `ANTHROPIC_API_KEY` set it calls the real model and prints precision and recall. The scoring, quote verification and matching code is the same in both modes.

### D-015 · Quote offsets are verified, and corrected when the quote is exact
LLMs copy text accurately but count characters badly. A candidate whose quote is an exact substring at the stated offsets is `exact`. If the quote is an exact substring elsewhere, we use the nearest occurrence and flag it `offset_corrected` (visible in the review queue). If it is not an exact substring anywhere, it is dropped and counted on the extraction run. Either way, nothing unsourced reaches a user.

### D-016 · Own magic-link auth instead of Auth.js
Login must resolve a user before a tenant is known, which with RLS means going through a narrow `SECURITY DEFINER` function, and every login must be audited. A small custom implementation (hashed single-use login tokens, hashed session tokens) is easier to make RLS-correct than adapting an auth library's adapter tables.

### D-017 · Rate limiting in Postgres
A fixed-window counter table works across multiple app instances without adding Redis. Load on public endpoints in pilots is tiny.

### D-018 · Link tokens are HMAC-signed and DB-revocable
`v1.<link_id>.<exp>.<sig>`: the signature binds the link to its contact and expiry; the database row provides revocation and open tracking. Rotating `LINK_SIGNING_SECRET` invalidates all outstanding links.

### D-019 · Authorization is per contact per engagement
A contact grants (or declines) authorization once per engagement, not once per request; the latest decision wins, so a contact who declined can return and grant. A new authorization text version requires a fresh grant.

### D-020 · Confirmation receipts anchor the chain externally (small addition)
A hash chain proves the log was not edited in place, but the vendor controls the database and could in principle rebuild a whole new chain. After a client submits responses, they receive a receipt email listing each item's short id, version and content hash plus the log head hash. The client then holds an independent copy that any rewritten history would contradict. Cost: one extra email per submission.

### D-021 · Business days
Monday to Friday in the engagement's IANA time zone; no holiday calendar in the MVP. Implemented with `date-fns` + `@date-fns/tz` because DST-correct zone arithmetic is not trivial.

### D-022 · Confirmation-rate denominator **[spec clarification]**
"Share of items sent for confirmation" is measured per **item version sent** (a revision sent again is a new attempt). Versions not yet 5 business days old are excluded (shown as "maturing"), and versions the vendor revised, withdrew or superseded before any client response inside the window are excluded as pulled rather than ignored. Without these exclusions the kill signal would fire on fresh pilots and on vendor churn.

### D-023 · Kind is immutable; short ids are allocated per kind
`ACME-R7` = the 7th requirement in engagement `ACME`. The id is allocated at command time and stored in the event payload, so it never changes and the projection stays pure. Changing an item's kind means superseding it with a new item.

### D-024 · Dependency rules
Dependents must be decisions or requirements (per spec). Upstream items can be any kind except the item itself; cycles are rejected.

### D-025 · Extraction runs synchronously after ingest
No job queue in the MVP: extraction runs in the ingest request after the source is committed, and its failure never rolls back the ingest. The `extraction_run` row records status so a retry button can re-run it.

### D-026 · Non-trivial dependencies we accepted
`mammoth` (.docx text), `pdfkit` (record PDF), `fast-check` (property tests), `date-fns` + `@date-fns/tz` (zone-aware business days), `nodemailer` (SMTP), `zod` (payload and tool schemas; required by the MCP SDK anyway). Everything else small (canonical JSON, word diff, token signing, rate limiting) is written in-house.

### D-027 · AI-off engagements export without quotes
The spec says that with AI off "no source text is sent to any model provider". The spec export and the MCP server exist to feed coding agents, which are model providers. For AI-off engagements both omit quote text and cite the source by type, date and character offsets instead; statements (vendor-authored agreement text) are still included. The vendor app UI shows full quotes as usual.

### D-028 · Architecture review changes (Phase 0 critique)
An independent review before Phase 1 led to these changes, all reflected in `ARCHITECTURE.md`:
- Source titles/filenames and free-text reasons moved out of the log (`source_content`, `event_note`); the log carries enum reason codes.
- `engagement_head` maintained by the insert trigger; `verifyChain` reports `truncated` when the log is shorter than or diverges from a known head (tail deletion is otherwise undetectable).
- Every command takes an injectable clock, so seed and tests build weeks of history through the real append path.
- Hash round-trip rules: app-supplied ms timestamps only, `int8` parsed as number, integers only in payloads, `verifyChain` hashes raw stored values.
- Confirmation evidence snapshots the confirmer's name and email; links store the address they were sent to; exports verify evidence commitments.
- All tenant tables carry `org_id` (incl. request item/contact tables), composite `(id, org_id)` foreign keys, and a catalog sweep test for RLS coverage. Operational tables never reference projection tables.
- Spans on revisions are carried over unchanged or edited; zero spans means manual.
- Link open metric counts first interaction (POST), since mail scanners prefetch links; raw opens are shown separately.
- Client submissions are one transaction with an idempotent `submission_id`.
- Extraction never holds a transaction open across the model call; AI flags are re-checked before candidates are written.
- `.vtt`/`.srt` uploads are always machine transcripts for the consent gate.
- Client page is rendered by route handlers as plain escaped HTML (no React hydration), so a strict CSP needs no nonces.
- `decisionContext` cuts off by event seq, not timestamp; `as_of` dates mean end of day in the engagement time zone.
- Per-source HMAC quote commitments were dropped as redundant with `source_sha256` + offsets.

### D-029 · Contacts may change their response while the link is valid
The latest response per contact counts (D-009). Every response remains in the log, so a changed mind is visible in the record.

### D-030 · Orgs are created by an operator script
`pnpm org:create --name ... --slug ... --admin-email ...` runs with the admin database URL. Self-serve signup is not needed for 10–12 design partners.

### D-031 · `record_candidates` is forced only where the model allows it
ARCHITECTURE §9.3 specifies a forced tool call. Claude Sonnet 5.5 (the default `ANTHROPIC_MODEL`), Opus 5.5, Fable 5.1 and Mythos 5.1 reject a forced `tool_choice` with HTTP 400. `AnthropicModelClient` therefore forces `record_candidates` on models that accept it and otherwise sends `tool_choice: auto` with `disable_parallel_tool_use`, a prompt instruction to call the tool exactly once, and `strict: true` on the tool so the input is schema-valid. A response without the tool call is retried once, then fails with `no_tool_call`. Server-side refusal fallbacks (a beta) are not enabled. A refusal fails the chunk with `refused`.

### D-032 · Database layer details (Phase 1a)
Choices made while implementing `packages/db`, within ARCHITECTURE §2 and §7:
- **Migration order.** `0000_extensions_and_roles` (hand-written: `citext`, guarded `veradact_app` creation) runs *before* the drizzle-kit-generated `0001_tables`, because table DDL uses `citext`. `0002_rls_and_grants`, `0003_append_only_log` and `0004_definer_functions` are hand-written; all five go through the Drizzle migrator in journal order. New tables need a `generate` migration plus a hand-written one adding RLS and grants (the catalog sweep and the cross-tenant table list fail until both exist).
- **`org` privileges.** The app role gets `SELECT, UPDATE` on `org` only; orgs are created by `pnpm org:create` (D-030) and never deleted by the app. All other operational and projection tables get `SELECT, INSERT, UPDATE, DELETE`; `event`/`audit_log` `SELECT, INSERT`; `engagement_head` `SELECT`.
- **No SQL timestamp defaults anywhere**, not only on `event.recorded_at/occurred_at`: every `created_at`, `expires_at` etc. comes from the application clock, so a forgotten clock fails loudly instead of mixing clocks in tests and metrics. Definer functions compare expiries with the database `now()`.
- **FK rule applied literally.** Projections reference only `engagement` (composite). Operational tables reference only org/app_user/engagement/client_contact/event, so `candidate.extraction_run_id`, `usage_event.api_token_id`, `confirmation_link.request_id` and other projection ids are plain uuids. No foreign key cascades. A catalog test enforces all of this.
- **Trigger errors.** Append-only rejections raise SQLSTATE `23001` (`event log is append-only` / `audit log is append-only`); chain violations raise `23000` with a message naming the failed check but no head values. The chain trigger is a `BEFORE INSERT` trigger and therefore runs before the RLS `WITH CHECK`; value-free messages keep a mis-targeted insert from learning another tenant's head.
- **Projection keys.** `contact_authorization` is keyed by `contact_id` (latest decision only, as the reducer keeps it); `item_response` by `(engagement_id, event_seq)`; `confirmation_request_item/contact` by `(request_id, item_id/contact_id)`; `item_dependency` by `(item_id, depends_on_item_id)`. `text_version` is text.
- **Shared test database.** The root Vitest globalSetup resets `veradact_test` once per run under an exclusive advisory lock and then holds a shared one until the run ends, so a second concurrent `pnpm test` waits instead of dropping the schema under the first.

### D-033 · Log Postgres errors through `getPgError`, never the thrown error
Drizzle 0.45 wraps driver errors in `DrizzleQueryError`, whose message is `Failed query: <sql> params: <values>` — the parameters can be names, emails, statements or tokens. CLAUDE.md and ARCHITECTURE §14 allow only SQLSTATE and constraint name in logs. `@veradact/db` exports `getPgError(error) → { code, constraint, message } | null`, which unwraps the cause; logging and error mapping must use it and must not log `error.message` of a query failure.

### D-034 · Supersede reason codes
§3 lists `reason_code` on `item_superseded` without values. Enum: `client_dispute | new_information | correction | scope_change | kind_change | duplicate | other`. `kind_change` covers D-023 (changing an item's kind means superseding it).

### D-035 · Payload value rules (hash round-trip safety)
Every payload value must survive a jsonb round trip byte-for-byte, so the zod schemas in `domain/events.ts` enforce: IDs are **lowercase** canonical UUID strings (any version; Postgres returns lowercase, and an uppercase id would hash differently from the stored row); digests are lowercase hex; timestamps inside payloads (`expires_at`) are exactly `Date.toISOString()` output; text has no NUL characters or lone UTF-16 surrogates (jsonb rejects both); numbers are safe integers. `canonicalJson` additionally rejects unsafe integers (> 2^53), Dates, Maps/Sets/typed arrays and other non-plain objects, symbol keys and cycles; keys sort by UTF-16 code unit. `parseEventDraft` drops `undefined`-valued keys (they would vanish in jsonb and break the hash) and rejects unknown keys (strict objects, so no PII can be added by accident). Also: statements are 1–2000 characters and not blank; an item or contact appears at most once per request; `authorization.text_version` is a string; the only `channel` is `email_link` (enum `ConfirmationChannelName`, named to leave `ConfirmationChannel` for the §15 seam). `parseEventDraft` also enforces who may author each type (`EVENT_ACTOR_TYPES`): client responses and authorizations by the contact named in the payload; `source_redacted`, `confirmation_revoked` and `contact_erased` by a user or `system`; everything else by a user — so `requested_by` and `ingested_by` are never null.

### D-036 · `occurred_at` rule and sealing
`source_ingested`, `item_created` and `item_revised` take `occurred_at` from the draft (falling back to `recorded_at`); every other event has `occurred_at = recorded_at`, whatever the draft says (`OCCURRED_AT_EVENT_TYPES`, `resolveOccurredAt`). The pure core of the append path is `nextRecordedAt(clock(), head.recordedAt)` + `sealEvent(draft, { orgId, engagementId, seq, prevHash, recordedAt })`; the DB append API should call exactly these so the app-computed hash and the trigger-assigned `seq`/`prev_hash` agree.

### D-037 · Reducer details
- Needs-review (D-011) flags only **active** direct dependents; a superseded or withdrawn dependent is never flagged. Reasons accumulate (`{upstreamItemId, cause, seq}`) until the dependent is revised or `review_cleared`.
- Any event whose payload names an existing item updates that item's `updatedAt`/`lastSeq`; so does a needs-review flag raised on a dependent. `createdAt` is the `recorded_at` of `item_created`.
- Total for well-formed events: references to unknown items/sources/requests are ignored; a duplicate `item_created`/`source_ingested`/`confirmation_requested` id is ignored (first write wins); repeated revocations and redactions keep the first time.
- State shape refinements of §5.1: `engagement` is null before genesis; `dependsOn` is `Map<upstreamId, addedSeq>` (the projection needs `added_seq`); request revocations are `revokedContacts: Map<contactId, at>` + `revokedAllAt` (the projection needs `revoked_at`); each item caches its derived `status`; responses and versions keep their seq.

### D-038 · Projection row conventions
`projectRows(state)` returns exactly the §2.3 columns (camelCase keys, Dates for timestamps). jsonb columns use snake_case keys like payloads: `review_reasons = [{upstream_item_id, cause, seq}]`, `spans = [{source_id, source_sha256, start, end, carried}]` where `carried` means the identical span was on the previous version. `item_response` has no `channel`/`evidence_commitment` columns in §2.3, so they are not projected (they stay in the log and in `EngagementState`). `source.ingested_by` is the event's actor, falling back to `attestation.attested_by`. `confirmation_request_item` has one row per (request, item), matching its primary key. Rows are sorted by `PROJECTION_SORT_KEYS` (the tables' primary keys, `item_response` by `event_seq`); a DB dump compared with them must use the same `ORDER BY`.

### D-039 · `verifyChain` semantics
Rows must be the full log from seq 1 in stored order; a gap, duplicate or reordering is `seq_gap`. Per row the checks are seq, then `prev_hash`, then the recomputed hash (an unhashable row is `hash_mismatch`, never a throw). `firstBadSeq` is the expected seq at the failing position; `checked`/`headSeq`/`headHash` describe the last good row (0 and 64 zeros for an empty log). `expectedHead` is checked after the chain: shorter log → `truncated` at `headSeq + 1`; different hash at `expectedHead.seq` → `truncated` at that seq. `expectedHead.seq = 0` is ignored.

### D-040 · Replay details
- Agreed view (D-010): an item's `confirmations` are the latest response per contact on that exact version (all confirmations, since the status is confirmed). Only **active** items appear in `items`, `previouslyAgreed` or `notConfirmed`; superseded and withdrawn items appear in none. `previouslyAgreed` uses the latest earlier version whose own responses make it confirmed. `notConfirmed` lists every other active item with `revisionPending` set for previously agreed ones (the "do not build" list).
- `diff(T1, T2)`: `added` = items created in (T1, T2] (shown at their T2 state, not also in `revised`); `revised` = items that existed at T1 with a different current version at T2; `confirmed`/`disputed`/`superseded`/`withdrawn` come from events in (T1, T2]; `changes` = every item whose version, hash, status, lifecycle or needs-review differs. `T1 > T2` throws.
- `decisionContext` defaults to the item's latest version and returns null for an unknown item or version.

### D-041 · Jurisdiction codes for the consent gate
Matching is case-insensitive and ignores surrounding whitespace. Accepted: two-letter codes (`CA`), `US-XX` (also `US_XX`, `US XX`) and full US state names (`California`, `District of Columbia`). A two-letter code that is a US state code is read as that state, so `DE` is Delaware, not Germany — the conservative reading, since only US states are on the all-party list and attesting consent always lets the uploader proceed. Anything else (a typo, `Germany`, `DE-BY`) is **unrecognized and treated as an unknown jurisdiction**, which blocks an unattested machine transcript under D-013. The stored attestation records the normalized, sorted codes and the normalized policy list; `CONSENT_POLICY_VERSION = 1`.

### D-042 · Business-day edge cases
`addBusinessDays(t, n, tz)` steps over local calendar dates in `tz` and keeps t's local wall time. A start on Saturday or Sunday counts the following Monday as business day 1 (Saturday + 1 = Monday, same time). A wall time that does not exist on the target day (spring-forward gap on a weekday, e.g. Africa/Cairo) resolves forward by the gap; an ambiguous one resolves as `TZDate` does (standard-time occurrence). `businessDaysBetween(a, b, tz)` counts weekdays d with date(a) < d ≤ date(b) and is the inverse of `addBusinessDays`.

### D-043 · Metric interpretation details
Metrics are computed as of `now` (later events, link timestamps and usage rows are ignored, like replay). A version is "pulled" when the first revise/withdraw/supersede after it was sent is recorded before `window_end` and no response to that version precedes it (compared by seq). A confirmation exactly at `window_end` counts. The median time to confirm includes confirmations on still-maturing versions. Link figures count only links whose email was sent. Churn counts a revision when any earlier `item_confirmed` exists on the item. CSV cells whose text starts with `= + - @`, tab or CR are prefixed with `'` so spreadsheets do not evaluate them.

### D-044 · Export rendering details
AI-off exports hide source titles as well as quotes (`quoteFor` is never called) and say so once in the header. User text is markdown-escaped and statement newlines are collapsed so a statement cannot inject headings or HTML. The spec's "Log head" is the head of the log the view reflects; a separate "Current log head" line appears when they differ. A revised item's previously agreed version never appears in the spec (it is listed under "Previously agreed versions" in the record). Dates render in the engagement time zone with an explicit UTC offset; record tables use exact UTC ISO timestamps. PDFs are deterministic (metadata dates come from `generatedAt`) and use built-in Helvetica only; characters it cannot draw become "?" while the markdown keeps the exact text.
