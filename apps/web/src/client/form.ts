// Reads the client items form. The server's fresh view decides which items can be answered; the
// hidden `v:<item id>` field (`<version>:<content hash>`) binds each answer to the version the
// contact was shown. A non-skip answer for an item that is no longer open, or a missing or
// mismatched binding, makes the form stale (nothing is recorded; the page is shown again).
import type { ClientFormResponse, ClientView } from "@veradact/core";
import type { Decision, FormValues } from "./pages";

const DECISIONS: readonly string[] = ["confirm", "dispute", "skip"];

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

export interface ParsedClientForm {
  responses: ClientFormResponse[];
  /** What was entered, for re-rendering. */
  values: Record<string, FormValues>;
  stale: boolean;
}

export function parseClientForm(form: FormData, view: Pick<ClientView, "items" | "updatedItems">): ParsedClientForm {
  const responses: ClientFormResponse[] = [];
  const values: Record<string, FormValues> = {};
  let stale = false;

  for (const item of view.items) {
    const raw = text(form, `d:${item.itemId}`);
    const decision: Decision = DECISIONS.includes(raw) ? (raw as Decision) : "skip";
    const comment = text(form, `c:${item.itemId}`);
    values[item.itemId] = { decision, comment };
    if (decision === "skip") continue;
    if (text(form, `v:${item.itemId}`) !== `${item.version}:${item.contentHash}`) {
      stale = true;
      continue;
    }
    responses.push({ itemId: item.itemId, version: item.version, contentHash: item.contentHash, decision, comment });
  }
  for (const item of view.updatedItems) {
    const raw = text(form, `d:${item.itemId}`);
    if (raw === "confirm" || raw === "dispute") stale = true;
  }
  return { responses, values, stale };
}
