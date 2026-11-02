// Shared between the source upload form (client) and its server action.

/** The sentence the uploader attests to for every source (ARCHITECTURE §9.2). */
export const SOURCE_ATTESTATION_TEXT =
  "I confirm that the source type, the participants' locations and the consent statement above are accurate to the best of my knowledge, and that I am allowed to add this text to the engagement's ledger.";

/** File types the upload accepts (audio and video are never accepted). */
export const ACCEPTED_SOURCE_EXTENSIONS = [".txt", ".md", ".vtt", ".srt", ".docx"] as const;

/** Formats that are always machine transcripts for the consent gate. */
export const TRANSCRIPT_EXTENSIONS = [".vtt", ".srt"] as const;

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

/** What the form submitted, returned on failure so the form keeps its values. */
export interface SourceFormValues {
  title: string;
  sourceType: string;
  date: string;
  participants: string;
  states: string[];
  otherJurisdictions: string;
  unknownJurisdictions: boolean;
  consented: boolean;
  text: string;
  /** Name of the file that was chosen (files cannot be re-filled; the user picks it again). */
  fileName: string;
}

export interface SourceFormState {
  status: "idle" | "error";
  message?: string;
  /** The consent gate's explanation when the ingest was blocked. */
  explanation?: string;
  values?: SourceFormValues;
  /** Increments per failed submission so the form re-mounts with the returned values. */
  attempt: number;
}
