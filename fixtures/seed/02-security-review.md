# HALV security and compliance review

- **Date:** 2026-09-15
- **Author:** Tomás Ferreira (Quillfield Labs)
- **Attendees:** Marcus Oyelaran and Dana Whitcombe (Halvorsen Freight); Priya Raman and Tomás Ferreira (Quillfield Labs)
- **Context:** Follow-up to the 09-08 kickoff. Marcus asked for a proper security review before anything touches production data.

## Data retention

- Marcus: route plans, override logs and driver telemetry are kept 90 days, then purged.
- Backups follow the same 90-day window. No longer-lived snapshots.
- Open question: does the override audit trail need longer retention for insurer requests? Dana to ask Legal.

## Encryption

- Encryption at rest is required for every datastore the assistant touches, with keys managed by Halvorsen IT in their own key store.
- TLS between the assistant, FleetDesk and the driver app; Marcus wants 1.2 as the minimum.

## Model prompts and PII

- No PII in model prompts. Driver names, phone numbers and home addresses are swapped for opaque IDs before anything reaches the model.
- Marcus wants a redaction test report before go-live.
- Tomás to write up the redaction approach and send it by 09-19.

## Testing and approvals

- A third-party penetration test must be completed before go-live. Quillfield books it, Halvorsen approves the tester.
- Marcus: Only Halvorsen IT can approve new integrations. Quillfield does not connect to anything new, even internal systems, without written approval from his team.
- Dana asked whether approval turnaround is bounded. Marcus: five business days is the usual.

## Identity

- Marcus: SSO is no longer optional for us. Security will not sign off on go-live with local accounts, so we need SSO through our identity provider before go-live.
- Priya noted this changes the kickoff position (SSO after the pilot). Tomás to check effort and report back.

## Action items

- Tomás: redaction approach doc, due 09-19.
- Tomás: SSO effort estimate, due 09-22 (for the scope call).
- Priya: book the penetration test window.
- Dana: ask Legal about audit trail retention.
