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
Each command folds the engagement's full event log to get current state, then appends. For pilot-sized engagements (hundreds to low thousands of events) this costs milliseconds and removes an entire class of drift bugs: the live path and the rebuild path run the same reducer from the same input. The DB projection tables are written from the state diff and exist for querying and RLS. Snapshots ("log compaction") can be added later behind `loadState` without changing callers.

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
Client contact PII, confirmation IP/user agent and dispute comments live in erasable side tables; source text lives in `source_content`. The log holds contact ids and HMAC commitments keyed per contact (or per source) — erasure deletes the rows and keys, the commitments become unlinkable, and the hash chain is untouched. This combines the spec's two suggested options (separate tables + destroyable per-subject keys).
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
