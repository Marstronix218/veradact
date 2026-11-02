"use client";

import { useActionState, useState, type ChangeEvent } from "react";
import { Button, Checkbox, Input, Notice, Select, Textarea } from "@/components";
import { SOURCE_TYPE_LABELS } from "@/lib/labels";
import {
  ACCEPTED_SOURCE_EXTENSIONS,
  fileExtension,
  SOURCE_ATTESTATION_TEXT,
  TRANSCRIPT_EXTENSIONS,
  type SourceFormState,
  type SourceFormValues,
} from "@/lib/source-form";
import { ingestSourceAction } from "../actions";

const EMPTY: SourceFormValues = {
  title: "",
  sourceType: "human_notes",
  date: "",
  participants: "",
  states: [],
  otherJurisdictions: "",
  unknownJurisdictions: false,
  consented: false,
  text: "",
  fileName: "",
};

/** Upload or paste a source with its consent attestation. Keeps its values when the ingest is blocked. */
export function SourceForm({
  engagementId,
  defaultDate,
  states,
  aiActive,
}: {
  engagementId: string;
  defaultDate: string;
  /** `[code, name]` pairs of US states. */
  states: readonly (readonly [string, string])[];
  aiActive: boolean;
}) {
  const [state, formAction, pending] = useActionState<SourceFormState, FormData>(ingestSourceAction, { status: "idle", attempt: 0 });
  return (
    <div className="space-y-4">
      {state.status === "error" ? (
        <Notice tone="error">
          <p className="font-medium">{state.message}</p>
          {state.explanation ? (
            <p className="mt-1" data-testid="consent-explanation">
              {state.explanation}
            </p>
          ) : null}
          {state.values?.fileName ? <p className="mt-1">Choose the file ({state.values.fileName}) again before resubmitting.</p> : null}
        </Notice>
      ) : null}
      <Fields
        key={state.attempt}
        engagementId={engagementId}
        values={{ ...EMPTY, date: defaultDate, ...state.values }}
        states={states}
        aiActive={aiActive}
        formAction={formAction}
        pending={pending}
      />
    </div>
  );
}

function Fields({
  engagementId,
  values,
  states,
  aiActive,
  formAction,
  pending,
}: {
  engagementId: string;
  values: SourceFormValues;
  states: readonly (readonly [string, string])[];
  aiActive: boolean;
  formAction: (formData: FormData) => void;
  pending: boolean;
}) {
  const [sourceType, setSourceType] = useState(values.sourceType);
  const [fileExt, setFileExt] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const transcriptFile = (TRANSCRIPT_EXTENSIONS as readonly string[]).includes(fileExt);
  const machine = sourceType === "machine_transcript" || transcriptFile;

  function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    if (!file) {
      setFileExt("");
      return;
    }
    const ext = fileExtension(file.name);
    if (!(ACCEPTED_SOURCE_EXTENSIONS as readonly string[]).includes(ext)) {
      event.currentTarget.value = "";
      setFileExt("");
      setFileError(`Unsupported file type. Choose a ${ACCEPTED_SOURCE_EXTENSIONS.join(", ")} file, or paste the text. Audio and video are never accepted.`);
      return;
    }
    setFileError(null);
    setFileExt(ext);
    if ((TRANSCRIPT_EXTENSIONS as readonly string[]).includes(ext)) setSourceType("machine_transcript");
  }

  return (
    <form action={formAction} className="space-y-6">
      <input type="hidden" name="engagementId" value={engagementId} />
      <fieldset disabled={pending} className="space-y-6">
        <section className="space-y-4">
          <Input name="title" label="Title" maxLength={300} defaultValue={values.title} placeholder="e.g. Scope call, Sept 22" hint="Defaults to the file name." />
          <div className="space-y-1">
            <label htmlFor="file" className="block text-sm font-medium text-zinc-800">
              File
            </label>
            <input
              id="file"
              name="file"
              type="file"
              accept={ACCEPTED_SOURCE_EXTENSIONS.join(",")}
              onChange={onFile}
              className="block w-full text-sm text-zinc-700 file:mr-3 file:rounded-md file:border file:border-zinc-300 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium"
            />
            <p className="text-xs text-zinc-500">.txt, .md, .vtt, .srt or .docx, up to 5 MB. Or paste the text below.</p>
            {fileError ? (
              <p role="alert" className="text-xs text-red-700">
                {fileError}
              </p>
            ) : null}
          </div>
          <Textarea name="text" label="Or paste the text" rows={8} defaultValue={values.text} className="font-mono text-xs" />
        </section>

        <section className="grid gap-4 sm:grid-cols-2">
          <Select
            name="sourceType"
            label="Source type"
            value={sourceType}
            onChange={(e) => setSourceType(e.currentTarget.value)}
            hint={transcriptFile ? ".vtt and .srt files are always treated as machine transcripts." : undefined}
          >
            {Object.entries(SOURCE_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
          <Input name="date" type="date" label="Source date" required defaultValue={values.date} hint="When the conversation happened." />
        </section>

        <section className="space-y-4">
          <Textarea
            name="participants"
            label="Participants"
            rows={4}
            defaultValue={values.participants}
            hint="One per line, as they appear in the source. Speaker labels are kept exactly as written."
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <label htmlFor="states" className="block text-sm font-medium text-zinc-800">
                Participant locations (US states)
              </label>
              <select
                id="states"
                name="states"
                multiple
                size={7}
                defaultValue={values.states}
                className="block w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm text-zinc-900"
              >
                {states.map(([code, name]) => (
                  <option key={code} value={code}>
                    {code} · {name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-zinc-500">Hold Ctrl or Cmd to pick several.</p>
            </div>
            <div className="space-y-4">
              <Input
                name="otherJurisdictions"
                label="Other locations"
                defaultValue={values.otherJurisdictions}
                placeholder="e.g. GB, Ontario"
                hint="Countries or regions, separated by commas."
              />
              <Checkbox name="unknownJurisdictions" label="Some participants' locations are unknown" defaultChecked={values.unknownJurisdictions} />
            </div>
          </div>
          {machine ? (
            <Checkbox
              name="consented"
              label="All participants consented to the recording"
              hint="Required for machine transcripts when anyone is in an all-party-consent state or their location is unknown."
              defaultChecked={values.consented}
            />
          ) : null}
        </section>

        <section className="rounded-md border border-zinc-200 bg-zinc-50 p-4">
          <Checkbox name="attest" required label={SOURCE_ATTESTATION_TEXT} />
        </section>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit">{pending ? "Adding…" : "Add source"}</Button>
          <p className="text-xs text-zinc-500">
            {aiActive
              ? "After the source is added, AI suggests items for you to review. Nothing enters the ledger until you accept it."
              : "AI suggestions are off for this engagement: no source text is sent to any model provider. You'll enter items manually."}
          </p>
        </div>
      </fieldset>
    </form>
  );
}
