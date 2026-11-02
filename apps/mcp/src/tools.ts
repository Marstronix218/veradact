// The read-only MCP tools (ARCHITECTURE §11). One McpServer per HTTP request, bound to the API
// token's org and user; every call runs inside withTenant and writes `usage_event(kind='mcp_fetch')`.
// Unknown and cross-tenant ids look the same ("not found"), and errors never echo DB messages.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  asOf,
  getEngagementSummary,
  getItemDetail,
  listEngagements,
  log,
  logError,
  logId,
  readEvents,
  ValidationError,
  type ItemDetail,
  type ResolvedApiTokenAuth,
} from "@veradact/core";
import { withTenant, type Db, type Tx } from "@veradact/db";
import { currentCut, effectiveAiEnabled, loadSpec, parseAsOf, recordUsage, resolveEngagementRef, resolveItemRef } from "@veradact/export/server";

export const SERVER_NAME = "veradact";
export const SERVER_VERSION = "0.1.0";

export const TOOL_NAMES = ["list_engagements", "get_confirmed_spec", "get_item", "list_unconfirmed"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const SERVER_INSTRUCTIONS = [
  "Veradact holds the client-confirmed scope of each engagement. Every item (problem, constraint, assumption, decision, requirement) has a stable short id such as HALV-R7.",
  "Rules for coding agents:",
  "1. Build only items the client has confirmed: the items in get_confirmed_spec, or get_item results with do_not_build: false.",
  "2. Never build items that are pending, disputed, revised after confirmation, superseded or withdrawn (list_unconfirmed, the spec's \"Not confirmed — do not build\" section, get_item with do_not_build: true), even if a confirmed item seems to imply them.",
  "3. Cite item ids (e.g. HALV-R7) in commit messages, pull request titles and pull request descriptions.",
  "4. An item marked needs review was confirmed, but something it depends on changed since. Check with the team before building on it.",
  "5. If something you need is not in the confirmed spec, ask the team instead of inferring it.",
  "Start with list_engagements. engagement_id accepts a UUID or short code (HALV); item_id accepts a UUID or short id (HALV-R7). The server is read-only and scoped to your API token's organization.",
].join("\n");

const AI_OFF_NOTE = "AI is off for this engagement: source quotes and titles are omitted; sources are cited by type, date and character offsets.";

export interface ToolDeps {
  db: Db;
  clock: () => Date;
  auth: ResolvedApiTokenAuth;
}

type Outcome = "ok" | "not_found" | "invalid_input" | "error";

/** A tool error whose message is safe to show the agent. */
class ToolFailure extends Error {
  constructor(
    readonly outcome: Exclude<Outcome, "ok" | "error">,
    message: string,
  ) {
    super(message);
  }
}

const engagementNotFound = () =>
  new ToolFailure("not_found", "Not found: no engagement with this id or short code is visible to your API token. Use list_engagements to see the available engagements.");
const itemNotFound = () => new ToolFailure("not_found", "Not found: no item with this id or short id is visible to your API token.");

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function jsonResult(value: unknown): CallToolResult {
  return textResult(JSON.stringify(value, null, 2));
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Runs one tool call in the token's tenant and meters it; failures roll back the usage row. */
async function runTool(deps: ToolDeps, tool: ToolName, fn: (tx: Tx) => Promise<{ result: CallToolResult; engagementId: string | null }>): Promise<CallToolResult> {
  const { orgId, userId, apiTokenId } = deps.auth;
  const fields = { tool, orgId: logId(orgId), apiTokenId: logId(apiTokenId) };
  try {
    const result = await withTenant(deps.db, { orgId, userId }, async (tx) => {
      const { result, engagementId } = await fn(tx);
      await recordUsage(tx, { orgId, engagementId, kind: "mcp_fetch", userId, apiTokenId, tool, at: deps.clock() });
      return result;
    });
    log.info("mcp.tool", { ...fields, outcome: "ok" as Outcome });
    return result;
  } catch (error) {
    if (error instanceof ToolFailure) {
      log.info("mcp.tool", { ...fields, outcome: error.outcome });
      return errorResult(error.message);
    }
    if (error instanceof ValidationError) {
      log.info("mcp.tool", { ...fields, outcome: "invalid_input" as Outcome });
      return errorResult(error.message);
    }
    logError("mcp.tool_failed", error, fields);
    return errorResult("Internal error. Try again later.");
  }
}

async function requireEngagement(tx: Tx, ref: string) {
  const engagement = await resolveEngagementRef(tx, ref);
  if (!engagement) throw engagementNotFound();
  return engagement;
}

function itemWarning(detail: ItemDetail, revisionPending: boolean): string | null {
  if (detail.lifecycle === "superseded") {
    return `Do not build: this item was superseded${detail.supersededBy ? ` by ${detail.supersededBy.shortId}` : ""}.`;
  }
  if (detail.lifecycle === "withdrawn") return "Do not build: this item was withdrawn.";
  const revision = revisionPending ? " An earlier version was confirmed, but the item was revised since and the new version is not confirmed." : "";
  if (detail.status === "disputed") return `Do not build: the client disputed the current version of this item.${revision}`;
  if (detail.status === "pending") return `Do not build: the client has not confirmed the current version of this item.${revision}`;
  if (detail.needsReview) return "Confirmed, but an item it depends on changed since the confirmation. Check with the team before building on it.";
  return null;
}

function itemJson(detail: ItemDetail, engagement: { id: string; shortCode: string; name: string }, aiEnabled: boolean) {
  const current = detail.versions.find((v) => v.version === detail.currentVersion);
  const revisionPending = detail.status !== "confirmed" && detail.versions.some((v) => v.version < detail.currentVersion && v.status === "confirmed");
  const doNotBuild = !(detail.status === "confirmed" && detail.lifecycle === "active");
  const warning = itemWarning(detail, revisionPending);
  const ref = (r: { shortId: string; kind: string; status: string; lifecycle: string; statement: string }) => ({
    short_id: r.shortId,
    kind: r.kind,
    status: r.status,
    lifecycle: r.lifecycle,
    statement: r.statement,
  });
  return {
    item_id: detail.id,
    short_id: detail.shortId,
    engagement: { id: engagement.id, short_code: engagement.shortCode, name: engagement.name },
    kind: detail.kind,
    status: detail.status,
    lifecycle: detail.lifecycle,
    do_not_build: doNotBuild,
    ...(warning ? { warning } : {}),
    revision_pending: revisionPending,
    needs_review: detail.needsReview,
    review_reasons: detail.reviewReasons.map((r) => ({ upstream: r.upstreamShortId, cause: r.cause })),
    superseded_by: detail.supersededBy?.shortId ?? null,
    current_version: detail.currentVersion,
    content_hash: current?.contentHash ?? null,
    statement: current?.statement ?? null,
    ...(aiEnabled ? {} : { quotes_omitted: AI_OFF_NOTE }),
    versions: detail.versions.map((v) => ({
      version: v.version,
      content_hash: v.contentHash,
      statement: v.statement,
      status: v.status,
      reason_code: v.reasonCode,
      occurred_at: v.occurredAt.toISOString(),
      recorded_at: v.recordedAt.toISOString(),
      manual: v.manual !== null,
      sources: v.spans.map((s) => ({
        source_type: s.sourceType,
        source_date: s.sourceOccurredAt?.toISOString() ?? null,
        start: s.start,
        end: s.end,
        redacted_at: s.sourceRedactedAt?.toISOString() ?? null,
        // D-027: no quote text or titles for AI-off engagements.
        ...(aiEnabled ? { title: s.sourceRedactedAt ? null : s.sourceTitle, quote: s.quote } : {}),
      })),
    })),
    responses: detail.versions
      .flatMap((v) => v.responses)
      .sort((a, b) => a.eventSeq - b.eventSeq)
      .map((r) => ({
        response: r.response,
        // AI-off engagements keep personal data out of what goes to coding agents (D-057).
        contact: aiEnabled ? r.contactName : "client contact",
        recorded_at: r.recordedAt.toISOString(),
        version: r.version,
        content_hash: r.contentHash,
      })),
    dependencies: detail.dependencies.map(ref),
    dependents: detail.dependents.map(ref),
  };
}

/** A fresh McpServer with the four read-only tools, bound to one authenticated token. */
export function createVeradactMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const engagementId = z.string().trim().min(1).max(64).describe("Engagement UUID or short code (e.g. HALV), from list_engagements.");

  server.registerTool(
    "list_engagements",
    {
      title: "List engagements",
      description:
        "List the engagements in your organization: id and short code (either works as engagement_id), name, client, status, how many active items the client has confirmed vs. not confirmed, and the log head seq. Start here to find the engagement you are working on.",
      annotations,
    },
    () =>
      runTool(deps, "list_engagements", async (tx) => {
        const engagements = [];
        for (const e of await listEngagements(tx)) {
          const summary = await getEngagementSummary(tx, e.id);
          const byStatus = summary?.items.byStatus ?? { confirmed: 0, pending: 0, disputed: 0 };
          engagements.push({
            id: e.id,
            short_code: e.shortCode,
            name: e.name,
            client: e.clientName,
            status: e.status,
            confirmed_items: byStatus.confirmed,
            not_confirmed_items: byStatus.pending + byStatus.disputed,
            log_head_seq: summary?.head?.seq ?? 0,
          });
        }
        return {
          engagementId: null,
          result: jsonResult({
            engagements,
            note: "Only confirmed items may be built. Use get_confirmed_spec with the id or short_code to get them.",
          }),
        };
      }),
  );

  server.registerTool(
    "get_confirmed_spec",
    {
      title: "Get the confirmed spec",
      description:
        "Get an engagement's client-confirmed specification as markdown. It contains ONLY items the client confirmed, each at the exact version and content hash confirmed, grouped by kind with sources and confirmers, followed by a \"Not confirmed — do not build\" list. Build only the confirmed items, never the ones in the do-not-build list, and cite item ids (e.g. HALV-R7) in commit messages and pull requests. Pass as_of to see the spec as it stood at an earlier time.",
      inputSchema: {
        engagement_id: engagementId,
        as_of: z
          .string()
          .trim()
          .min(1)
          .max(64)
          .optional()
          .describe("Optional point in time: YYYY-MM-DD (end of that day in the engagement's time zone) or an ISO 8601 timestamp with offset. Omit for the current spec."),
      },
      annotations,
    },
    ({ engagement_id, as_of }) =>
      runTool(deps, "get_confirmed_spec", async (tx) => {
        const engagement = await requireEngagement(tx, engagement_id);
        const at = as_of === undefined ? null : parseAsOf(as_of, engagement.timeZone);
        const { markdown } = await loadSpec(tx, { engagementId: engagement.id, asOf: at, clock: deps.clock });
        return { engagementId: engagement.id, result: textResult(markdown) };
      }),
  );

  server.registerTool(
    "get_item",
    {
      title: "Get one item",
      description:
        "Get one item by UUID or short id (e.g. HALV-R7) as JSON: kind, status, lifecycle, current version and content hash, statement, every version, client confirmations and disputes, and dependencies. Items that are not confirmed, superseded or withdrawn carry do_not_build: true and a warning: do not implement them. When you build a confirmed item, cite its short id in commits and pull requests.",
      inputSchema: {
        item_id: z.string().trim().min(1).max(64).describe("Item UUID or short id (e.g. HALV-R7)."),
      },
      annotations,
    },
    ({ item_id }) =>
      runTool(deps, "get_item", async (tx) => {
        const ref = await resolveItemRef(tx, item_id);
        const engagement = ref ? await resolveEngagementRef(tx, ref.engagementId) : null;
        const detail = ref && engagement ? await getItemDetail(tx, engagement.id, ref.itemId) : null;
        if (!engagement || !detail) throw itemNotFound();
        const aiEnabled = await effectiveAiEnabled(tx, engagement);
        return { engagementId: engagement.id, result: jsonResult(itemJson(detail, engagement, aiEnabled)) };
      }),
  );

  server.registerTool(
    "list_unconfirmed",
    {
      title: "List unconfirmed items",
      description:
        "List the active items in an engagement whose current version the client has NOT confirmed: pending, disputed, or revised after an earlier confirmation. Do not build any of these; they are listed so you know what to leave alone.",
      inputSchema: { engagement_id: engagementId },
      annotations,
    },
    ({ engagement_id }) =>
      runTool(deps, "list_unconfirmed", async (tx) => {
        const engagement = await requireEngagement(tx, engagement_id);
        // The whole log: recorded_at may run ahead of this server's clock (`currentCut`).
        const events = await readEvents(tx, engagement.id);
        const view = asOf(events, currentCut(deps.clock(), events), "agreed");
        const items = view.notConfirmed;
        const lines =
          items.length === 0
            ? [`Do not build these: none. Every active item in ${engagement.shortCode} is confirmed; get_confirmed_spec lists them.`]
            : [
                `Do not build these: ${items.length} item${items.length === 1 ? "" : "s"} in ${engagement.shortCode} ${items.length === 1 ? "is" : "are"} not confirmed by the client.`,
                "Their current versions are pending, disputed, or revised after an earlier confirmation. Leave them alone until the client confirms them; get_confirmed_spec lists what may be built.",
                "",
                ...items.map((i) => {
                  const status = i.revisionPending ? `revision ${i.status}; previously agreed` : i.status;
                  return `- ${i.shortId} [${i.kind}, ${status}] ${oneLine(i.statement)}`;
                }),
              ];
        return { engagementId: engagement.id, result: textResult(lines.join("\n")) };
      }),
  );

  return server;
}
