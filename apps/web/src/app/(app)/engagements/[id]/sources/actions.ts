"use server";

import { revalidatePath } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import {
  AiDisabledError,
  ConsentBlockedError,
  ingestSource,
  isCoreError,
  logError,
  logId,
  modelClientFromEnv,
  redactSource,
  runExtraction,
  ValidationError,
  type SourceFormat,
  type SourceType,
} from "@veradact/core";
import { detectFormat, IngestError, parseSource, type ParsedSource } from "@veradact/ingest";
import { runAction } from "@/lib/actions";
import { commandContext, field } from "@/lib/commands";
import { parseLocalDate } from "@/lib/dates";
import { getEngagement } from "@/lib/engagement";
import type { FormState } from "@/lib/form-state";
import { enumValue, REDACTION_REASON_LABELS, SOURCE_TYPE_LABELS } from "@/lib/labels";
import type { SourceFormState, SourceFormValues } from "@/lib/source-form";

const MAX_PARTICIPANTS = 100;

function readValues(formData: FormData): SourceFormValues {
  const file = formData.get("file");
  return {
    title: field(formData, "title"),
    sourceType: field(formData, "sourceType"),
    date: field(formData, "date"),
    participants: String(formData.get("participants") ?? ""),
    states: formData.getAll("states").filter((v): v is string => typeof v === "string"),
    otherJurisdictions: field(formData, "otherJurisdictions"),
    unknownJurisdictions: formData.get("unknownJurisdictions") === "on",
    consented: formData.get("consented") === "on",
    text: String(formData.get("text") ?? ""),
    fileName: file instanceof File ? file.name : "",
  };
}

async function readSource(formData: FormData, values: SourceFormValues): Promise<{ parsed: ParsedSource; format: SourceFormat; filename: string | null }> {
  const file = formData.get("file");
  if (file instanceof File && file.size > 0) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const format = detectFormat(file.name, bytes);
    return { parsed: await parseSource({ format, bytes, filename: file.name }), format, filename: file.name };
  }
  if (values.text.trim() === "") throw new ValidationError("Paste the source text or choose a file.", "text");
  return { parsed: await parseSource({ format: "paste", text: values.text }), format: "paste", filename: null };
}

/**
 * Ingests a source with its consent attestation, then (when AI is on) runs extraction and opens
 * the review queue; with AI off it opens manual entry. A blocked ingest returns the consent
 * explanation and the submitted values.
 */
export async function ingestSourceAction(prev: SourceFormState, formData: FormData): Promise<SourceFormState> {
  const values = readValues(formData);
  const attempt = prev.attempt + 1;
  let destination: string;
  try {
    const ctx = await commandContext();
    const engagement = await getEngagement(field(formData, "engagementId"));
    if (!engagement) throw new ValidationError("That engagement does not exist.");
    if (formData.get("attest") !== "on") throw new ValidationError("Confirm the attestation to add this source.", "attest");
    const sourceType = enumValue<SourceType>(SOURCE_TYPE_LABELS, values.sourceType);
    if (!sourceType) throw new ValidationError("Choose a source type.", "sourceType");
    const occurredAt = parseLocalDate(values.date, engagement.timeZone, "date");
    const participants = values.participants
      .split("\n")
      .map((p) => p.trim())
      .filter(Boolean);
    if (participants.length > MAX_PARTICIPANTS) throw new ValidationError(`List at most ${MAX_PARTICIPANTS} participants.`, "participants");
    const { parsed, format, filename } = await readSource(formData, values);
    const jurisdictions = [
      ...values.states,
      ...values.otherJurisdictions
        .split(/[,;\n]/)
        .map((j) => j.trim())
        .filter(Boolean),
    ];
    const machine = sourceType === "machine_transcript" || format === "vtt" || format === "srt";

    const { sourceId } = await ingestSource(ctx, {
      engagementId: engagement.id,
      parsed,
      title: values.title || filename,
      filename,
      format,
      sourceType,
      occurredAt,
      participants,
      attestation: {
        allParticipantsConsented: machine && values.consented ? true : null,
        jurisdictions,
        jurisdictionsKnown: !values.unknownJurisdictions && jurisdictions.length > 0,
      },
    });
    const base = `/engagements/${engagement.id}`;
    revalidatePath(base, "layout");

    // Extraction failure never undoes the ingest (D-025); AI off is enforced inside runExtraction.
    try {
      const run = await runExtraction({ ...ctx, engagementId: engagement.id, sourceId, modelClientFactory: modelClientFromEnv });
      destination = `${base}/review?run=${run.runId}`;
    } catch (error) {
      if (error instanceof AiDisabledError) destination = `${base}/items/new?source=${sourceId}&notice=ai_off`;
      else {
        logError("web.extraction_failed", error, { sourceId: logId(sourceId) });
        destination = `${base}/review?extraction=error`;
      }
    }
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ConsentBlockedError) return { status: "error", message: error.message, explanation: error.explanation, values, attempt };
    if (error instanceof IngestError || isCoreError(error)) return { status: "error", message: error.message, values, attempt };
    logError("web.ingest_failed", error);
    return { status: "error", message: "Something went wrong. Please try again.", values, attempt };
  }
  redirect(destination);
}

export async function redactSourceAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return runAction(async () => {
    const ctx = await commandContext();
    const engagementId = field(formData, "engagementId");
    if (formData.get("understood") !== "on") throw new ValidationError("Confirm that the source text will be deleted.", "understood");
    const reasonCode = enumValue(REDACTION_REASON_LABELS, field(formData, "reasonCode"));
    if (!reasonCode) throw new ValidationError("Choose a reason.", "reasonCode");
    await redactSource(ctx, { engagementId, sourceId: field(formData, "sourceId"), reasonCode, note: field(formData, "note") || null });
    revalidatePath(`/engagements/${engagementId}`, "layout");
    return "Source redacted. Its text is deleted; items keep their citations.";
  });
}

/** Re-runs extraction for a source (review queue). Replaces the source's pending suggestions. */
export async function rerunExtractionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  let destination: string | undefined;
  const state = await runAction(async () => {
    const ctx = await commandContext();
    const engagementId = field(formData, "engagementId");
    const run = await runExtraction({ ...ctx, engagementId, sourceId: field(formData, "sourceId"), modelClientFactory: modelClientFromEnv });
    destination = `/engagements/${engagementId}/review?run=${run.runId}`;
  });
  if (destination) redirect(destination);
  return state;
}
