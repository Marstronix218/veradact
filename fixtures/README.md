# Veradact fixtures

Everything here is synthetic. All companies (Quillfield Labs, Halvorsen Freight, Wexcombe Retail Group, Ostrander Mutual, Calder Valley Health, Fennimore Savings Bank), products (FleetDesk) and people are fictional, and all email addresses use reserved `.example` domains. Any resemblance to real organizations or individuals is accidental.

Run `node fixtures/check-fixtures.mjs` (no dependencies) to validate everything. It exits non-zero on any failure.

## Layout

### `seed/` - the demo engagement (Halvorsen Freight, short code HALV)

| File | Purpose |
| --- | --- |
| `01-kickoff.vtt` | Machine transcript (WebVTT, `<v Name>` voice tags), 2026-09-08. Problems, constraints, assumptions, decisions and requirements. Long cues are wrapped over several physical lines. |
| `02-security-review.md` | Human-written notes by Tomás, 2026-09-15. Retention, encryption, PII in prompts, pen test, integration approvals, SSO before go-live. |
| `03-scope-call.srt` | Machine transcript (SRT, leading `Name:`), 2026-09-22. Contains the 5:30 -> 5:00 change, a new requirement (driver pins), a withdrawn assumption (Dayton), two disputes (read-only access, Android-only) and a decision that depends on an assumption (polling the FleetDesk REST API). |
| `items.json` | 24 ledger items (see below). |
| `contacts.json` | The three Halvorsen contacts. |
| `participants.json` | Per source: date, type, US state jurisdiction (one-party-consent states: OH, TX), `consent_attested: true`, participant list. |

`items.json` fields: `key`, `kind`, `statement`, `source`, `quote`, `speaker`, `depends_on`, `revises`, `superseded_by`, `demo_status`, plus an optional `followup` object (`source`, `quote`, `speaker`) on disputed and withdrawn items that points at the later quote which disputes or retracts the item.

Status conventions used by the seed:

- A confirmed item that was later changed is replaced by a new item with `revises: <old key>` and status `revised_after_confirmation`; the old item gets status `superseded` and `superseded_by: <new key>`. Two such pairs exist: 5:30 -> 5:00 (`k18` -> `k19`) and SSO later -> SSO before go-live (`k21` -> `k22`).
- Items that depend on a superseded or disputed item are `needs_review` (`k16`, `k23` depend on `k18`).
- `k3` and `k12` are manual items (`source`, `quote`, `speaker` all null).
- `depends_on` appears only on decisions and requirements.

### `eval/` - extraction eval set (different fictional clients)

| Source | Format | Client |
| --- | --- | --- |
| `e1-retail-kickoff.vtt` | WebVTT | Wexcombe Retail Group |
| `e2-insurer-notes.md` | Markdown notes | Ostrander Mutual |
| `e3-hospital-scope.srt` | SRT | Calder Valley Health |
| `e4-bank-email.txt` | Email thread export | Fennimore Savings Bank |

For each source `<name>`:

- `<name>.expected.json`: `{ source, expected: [{ kind, quote, statement }] }`, the ground truth.
- `<name>.recorded.json`: a plausible imperfect model output `{ _notes, candidates: [{ kind, statement, quote, start, end, speaker_label, confidence, suggested_depends_on, revises }] }`. `start`/`end` are character offsets into the normalized text. `_notes` lists the deliberate flaws in a parseable form: `candidates[i]: FLAW - ...` or `expected[i]: MISSED - ...`.

Deliberate flaws across the set: 2 `WRONG_OFFSETS` (exact quote, bad start/end), 2 `HALLUCINATED_QUOTE` (paraphrase not in the source), 2 `FALSE_POSITIVE` (real quote, not in expected), 3 `MISSED` (expected item with no candidate), 1 `KIND_MISMATCH`. The checker recomputes these from the data and fails if `_notes` disagrees or the totals drift.

## Normalization contract

The app turns each file into plain text before quotes are matched or offsets computed.

- `.vtt`: the `WEBVTT` header, cue ids and timing lines are removed. `<v Name>text</v>` becomes the line `Name: text`. Multi-line cue text is joined with a single space.
- `.srt`: cue numbers and timing lines are removed. Cue text lines are joined with a single space. A leading `Name:` stays as is.
- `.md` / `.txt`: kept as is, with line endings normalized to `\n`.

Each normalized cue/line is one utterance. Every quote in these fixtures:

- is copied verbatim from within a single utterance (never across two cues or lines, never including the speaker label or timestamps),
- is 20-250 characters of plain ASCII (no smart quotes or em dashes),
- occurs exactly once in the normalized text of its source,

except the deliberate `HALLUCINATED_QUOTE` candidates, which must not occur at all. Because wrapped cue lines are joined with a space, some quotes span a physical line break in the raw `.vtt`/`.srt` file; they only match after normalization.

For `.vtt`/`.srt` sources the speaker is the leading label of the quote's line. For `.md` notes it is a `Name:` prefix on the bullet when present, otherwise null. For the `.txt` email export it is the sender of the enclosing message.
