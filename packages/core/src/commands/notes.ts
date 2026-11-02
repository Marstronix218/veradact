// Optional free-text explanations for revise/withdraw/supersede/redact live in `event_note`
// (erasable, never hashed); the event itself carries only an enum reason code (ARCHITECTURE §6).
import { eventNote, type Tx } from "@veradact/db";
import { DomainError } from "../errors";

export const NOTE_MAX = 2000;

/** Trimmed note, or null when absent/blank. Validate before appending. */
export function cleanNote(note: string | null | undefined): string | null {
  if (note === undefined || note === null) return null;
  const trimmed = note.trim();
  if (trimmed === "") return null;
  if (trimmed.length > NOTE_MAX || trimmed.includes("\u0000")) throw new DomainError("invalid_note");
  return trimmed;
}

export async function writeNote(tx: Tx, orgId: string, eventId: number, note: string | null): Promise<void> {
  if (note === null) return;
  await tx.insert(eventNote).values({ eventId, orgId, note });
}
