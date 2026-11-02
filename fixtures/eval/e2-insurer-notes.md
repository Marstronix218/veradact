# Ostrander Mutual - claims triage assistant, discovery notes

- Date: 2026-10-05
- Author: Tomás Ferreira (Quillfield Labs)
- Attendees: Helena Brandt (Head of Claims), Victor Aldana (Claims IT), Fatima Idowu (Subrogation), Priya Raman, Tomás Ferreira

## Current state

- Helena: Adjusters spend about 40 percent of their day reading and re-keying first notices of loss, and first assignment takes 1.8 days on average.
- Intake channels today: phone, web form and agent email.

## Constraints

- Victor: Claims data may not be sent to any model endpoint outside the United States.
- Every system that touches a claim file must be logged for the state regulator audit.
- Claims systems are under a change freeze from Nov 20 to Jan 6, so no deployments in that window.

## Assumptions

- Victor: We assume the policy admin system exposes claim status through a nightly export.
- Tomás to confirm the export format (CSV or JSON) with Victor.

## Scope

- Start with auto glass and minor property claims only; bodily injury and anything with a litigation flag stays manual.
- Fatima floated using the assistant for subrogation screening later; parked, not a commitment.

## Requirements

- Adjusters can reject any triage suggestion and see why it was suggested.
- Triage must complete within 2 minutes of first notice of loss.

## Open questions

- Does Legal need to review adjuster-facing explanations?
- Which state regulator template applies to the audit log?

## Action items

- Tomás: send draft item list for confirmation by Oct 9.
- Victor: share the nightly export sample by Oct 12.
- Helena: nominate two adjusters for the pilot group.
