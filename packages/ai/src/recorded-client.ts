import { z } from "zod";
import {
  ModelClientError,
  RawCandidateListSchema,
  type ExtractionInput,
  type ModelClient,
  type RawCandidate,
} from "./model-client";

/** Shape of fixtures/eval/*.recorded.json (`_notes` describes the deliberate flaws; ignored here). */
export const RecordedResponseSchema = z.object({
  _notes: z.array(z.string()).optional(),
  candidates: RawCandidateListSchema,
});
export type RecordedResponse = z.infer<typeof RecordedResponseSchema>;

export interface Recording {
  /** The exact normalized source text the recording answers. */
  sourceText: string;
  candidates: RawCandidate[];
}

/**
 * Replays recorded model output, keyed by the exact source text, so the eval and tests run
 * the real verification and scoring code without a network call (D-014). Unknown text throws
 * `no_recording`.
 */
export class RecordedModelClient implements ModelClient {
  readonly name: string;
  private readonly byText = new Map<string, RawCandidate[]>();

  constructor(recordings: readonly Recording[], name = "recorded") {
    this.name = name;
    for (const r of recordings) this.byText.set(r.sourceText, RawCandidateListSchema.parse(r.candidates));
  }

  async extract(input: ExtractionInput): Promise<RawCandidate[]> {
    const candidates = this.byText.get(input.sourceText);
    if (!candidates) throw new ModelClientError("no_recording");
    return candidates.map((c) => ({ ...c, suggested_depends_on: [...c.suggested_depends_on] }));
  }
}
