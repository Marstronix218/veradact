// The MCP server end to end: real HTTP on an ephemeral port, the SDK client, real API tokens and
// the test database (app role, RLS enforced). Engagements come from the shared export scenario.
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, describe, expect, it } from "vitest";
import { createApiToken, reviseItem, revokeApiToken, type CreatedApiToken } from "@veradact/core";
import { usageEvent, withTenant } from "@veradact/db";
import { adminTestDb, testDb } from "@veradact/db/testing";
import { createExportScenario, type ExportScenario, type ExportScenarioOptions } from "@veradact/export/server/testing";
import { createMcpHttpServer, type McpHttpServerOptions } from "./server";
import { TOOL_NAMES } from "./tools";

const app = testDb({ max: 5 });
const admin = adminTestDb();
const servers: Server[] = [];
const clients: Client[] = [];

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
  await Promise.all([app.close(), admin.close()]);
});

const NOT_CONFIRMED = "## Not confirmed — do not build";

async function startServer(options: Partial<McpHttpServerOptions> = {}): Promise<string> {
  const server = createMcpHttpServer({ db: app.db, rateLimits: { perTokenPerMinute: 1000, perIpPerMinute: 1000 }, ...options });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

const sharedUrl = startServer();

/** A distinct client IP per caller (sent as x-forwarded-for), so per-IP buckets never collide. */
let ipSerial = 0;
function uniqueIp(): string {
  ipSerial += 1;
  return `198.51.${Math.floor(ipSerial / 250)}.${(ipSerial % 250) + 1}`;
}

async function scenarioWithToken(options: ExportScenarioOptions = {}): Promise<{ s: ExportScenario; token: CreatedApiToken }> {
  const s = await createExportScenario(app, admin.db, options);
  const token = await createApiToken({ db: app.db, ctx: { orgId: s.orgId, userId: s.userId, role: "admin" }, clock: () => new Date(), name: "Coding agent" });
  return { s, token };
}

async function connect(token: string, url?: string): Promise<Client> {
  const client = new Client({ name: "veradact-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url ?? (await sharedUrl)), {
    requestInit: { headers: { authorization: `Bearer ${token}`, "x-forwarded-for": uniqueIp() } },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string }> {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult;
  expect(result.content).toHaveLength(1);
  expect(result.content[0]!.type).toBe("text");
  return { isError: result.isError === true, text: result.content[0]!.text ?? "" };
}

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "raw", version: "0" } },
});

function post(url: string, options: { token?: string; ip?: string; body?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "x-forwarded-for": options.ip ?? uniqueIp(),
  };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  return fetch(url, { method: "POST", headers, body: options.body ?? INITIALIZE });
}

async function usageRows(s: ExportScenario, apiTokenId: string) {
  const rows = await withTenant(app.db, { orgId: s.orgId }, (tx) => tx.select().from(usageEvent));
  return rows.filter((r) => r.apiTokenId === apiTokenId);
}

describe("tools", () => {
  it("lists the four read-only tools with input schemas, and the server instructions", async () => {
    const { token } = await scenarioWithToken();
    const client = await connect(token.token);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.description).toBeTruthy();
    }
    const spec = tools.find((t) => t.name === "get_confirmed_spec")!;
    expect(Object.keys(spec.inputSchema.properties ?? {}).sort()).toEqual(["as_of", "engagement_id"]);
    expect(spec.inputSchema.required).toEqual(["engagement_id"]);
    expect(tools.find((t) => t.name === "get_item")!.inputSchema.required).toEqual(["item_id"]);
    expect(client.getInstructions()).toContain("Build only items the client has confirmed");
    expect(client.getInstructions()).toContain("Cite item ids");
  });

  it("list_engagements returns the org's engagements with counts and the log head", async () => {
    const { s, token } = await scenarioWithToken();
    const client = await connect(token.token);
    const { isError, text } = await call(client, "list_engagements");
    expect(isError).toBe(false);
    const { engagements } = JSON.parse(text) as { engagements: Record<string, unknown>[] };
    expect(engagements).toHaveLength(1);
    expect(engagements[0]).toMatchObject({
      id: s.engagementId,
      short_code: "HALV",
      name: "Dispatch portal rebuild",
      client: "Halvorsen Freight",
      status: "active",
      confirmed_items: 2,
      not_confirmed_items: 3,
    });
    expect(engagements[0]!.log_head_seq).toBeGreaterThan(10);
  });

  it("get_confirmed_spec returns only confirmed items plus the do-not-build section", async () => {
    const { s, token } = await scenarioWithToken();
    const { r1, d1, r2, a1, c1 } = s.items;
    const client = await connect(token.token);
    const { isError, text } = await call(client, "get_confirmed_spec", { engagement_id: "halv" });
    expect(isError).toBe(false);
    const [confirmed, notConfirmed] = text.split(NOT_CONFIRMED);
    expect(notConfirmed).toBeDefined();
    for (const item of [r1, d1]) {
      expect(confirmed).toContain(`### ${item.shortId} · ${item.statement}`);
      expect(notConfirmed).not.toContain(item.shortId);
    }
    for (const item of [r2, a1, c1]) {
      expect(confirmed).not.toContain(item.statement);
      expect(notConfirmed).toContain(`- ${item.shortId} · ${item.statement}`);
    }

    const byUuid = await call(client, "get_confirmed_spec", { engagement_id: s.engagementId });
    expect(byUuid.text.split(NOT_CONFIRMED)[0]).toContain(`### ${r1.shortId}`);
  });

  it("get_confirmed_spec honours as_of and rejects an invalid one", async () => {
    const { s, token } = await scenarioWithToken();
    const client = await connect(token.token);
    const past = await call(client, "get_confirmed_spec", { engagement_id: "HALV", as_of: "2026-03-05" });
    expect(past.isError).toBe(false);
    expect(past.text).toContain('as_of: "2026-03-06T04:59:59.999Z"');
    const [confirmed, notConfirmed] = past.text.split(NOT_CONFIRMED);
    expect(confirmed).toContain(`### ${s.items.r1.shortId}`);
    expect(confirmed).not.toContain(s.items.d1.statement);
    expect(notConfirmed).toContain(`${s.items.d1.shortId} · ${s.items.d1.statement} (pending)`);

    const invalid = await call(client, "get_confirmed_spec", { engagement_id: "HALV", as_of: "last tuesday" });
    expect(invalid.isError).toBe(true);
    expect(invalid.text).toContain("as_of must be a date (YYYY-MM-DD");
  });

  it("get_item marks unconfirmed items do_not_build and shows confirmations on confirmed ones", async () => {
    const { s, token } = await scenarioWithToken();
    const client = await connect(token.token);

    const pending = JSON.parse((await call(client, "get_item", { item_id: "halv-r2" })).text);
    expect(pending).toMatchObject({ short_id: "HALV-R2", item_id: s.items.r2.itemId, kind: "requirement", status: "pending", lifecycle: "active", do_not_build: true });
    expect(pending.warning).toMatch(/^Do not build: the client has not confirmed/);

    const disputed = JSON.parse((await call(client, "get_item", { item_id: s.items.a1.itemId })).text);
    expect(disputed).toMatchObject({ short_id: "HALV-A1", status: "disputed", do_not_build: true });
    expect(disputed.responses).toEqual([expect.objectContaining({ response: "disputed", contact: "Ada Client", version: 1 })]);
    expect(JSON.stringify(disputed)).not.toContain("carriers yet"); // dispute comments are not exposed

    const confirmed = JSON.parse((await call(client, "get_item", { item_id: "HALV-R1" })).text);
    expect(confirmed).toMatchObject({
      short_id: "HALV-R1",
      status: "confirmed",
      do_not_build: false,
      current_version: 1,
      content_hash: s.items.r1.contentHash,
      statement: s.items.r1.statement,
    });
    expect(confirmed.warning).toBeUndefined();
    expect(confirmed.versions).toHaveLength(1);
    expect(confirmed.versions[0]).toMatchObject({ version: 1, content_hash: s.items.r1.contentHash, statement: s.items.r1.statement, status: "confirmed" });
    expect(confirmed.versions[0].sources[0]).toMatchObject({ source_type: "human_notes", quote: s.items.r1.quote, title: "Kickoff notes" });
    expect(confirmed.responses.map((r: { contact: string }) => r.contact)).toEqual(["Ada Client", "Ben Client"]);
  });

  it("get_item omits quote text and titles for AI-off engagements", async () => {
    const { s, token } = await scenarioWithToken({ engagementAiEnabled: false });
    const client = await connect(token.token);
    const { text } = await call(client, "get_item", { item_id: "HALV-R1" });
    const item = JSON.parse(text);
    expect(item.quotes_omitted).toMatch(/AI is off/);
    expect(item.versions[0].sources[0]).toMatchObject({ source_type: "human_notes", start: expect.any(Number), end: expect.any(Number) });
    expect(item.versions[0].sources[0]).not.toHaveProperty("quote");
    expect(item.versions[0].sources[0]).not.toHaveProperty("title");
    expect(text).not.toContain(s.items.r1.quote!);
    expect(text).not.toContain("Kickoff notes");
    // Confirmations are shown without the contacts' names.
    expect(item.responses.map((r: { contact: string; response: string }) => [r.contact, r.response])).toEqual([
      ["client contact", "confirmed"],
      ["client contact", "confirmed"],
    ]);
    expect(text).not.toMatch(/Ada Client|Ben Client/);
  });

  it("list_unconfirmed lists pending, disputed and never-requested items under a do-not-build header", async () => {
    const { s, token } = await scenarioWithToken();
    const client = await connect(token.token);
    const { isError, text } = await call(client, "list_unconfirmed", { engagement_id: "HALV" });
    expect(isError).toBe(false);
    expect(text.split("\n")[0]).toBe("Do not build these: 3 items in HALV are not confirmed by the client.");
    expect(text).toContain(`- ${s.items.r2.shortId} [requirement, pending] ${s.items.r2.statement}`);
    expect(text).toContain(`- ${s.items.a1.shortId} [assumption, disputed] ${s.items.a1.statement}`);
    expect(text).toContain(`- ${s.items.c1.shortId} [constraint, pending] ${s.items.c1.statement}`);
    expect(text).not.toContain(s.items.r1.shortId);
    expect(text).not.toContain(s.items.d1.shortId);
  });

  it("without as_of, list_unconfirmed and get_confirmed_spec see the whole log even when it was recorded ahead of the server's clock", async () => {
    const { s, token } = await scenarioWithToken();
    // The writer's clock is ahead: R1 (confirmed Mar 3) is revised at Mar 20, while this server reads Mar 15.
    s.clock.jump(new Date("2026-03-20T15:00:00.000Z"));
    const revised = "The dispatch dashboard refreshes every two minutes.";
    await reviseItem(s.ctx, { engagementId: s.engagementId, itemId: s.items.r1.itemId, statement: revised, reasonCode: "scope_change" });
    const url = await startServer({ clock: () => new Date("2026-03-15T12:00:00.000Z") });
    const client = await connect(token.token, url);

    const unconfirmed = await call(client, "list_unconfirmed", { engagement_id: "HALV" });
    expect(unconfirmed.isError).toBe(false);
    expect(unconfirmed.text).toContain(`- ${s.items.r1.shortId} [requirement, revision pending; previously agreed] ${revised}`);
    const spec = await call(client, "get_confirmed_spec", { engagement_id: "HALV" });
    const [confirmed, notConfirmed] = spec.text.split(NOT_CONFIRMED);
    expect(confirmed).not.toContain(`### ${s.items.r1.shortId}`);
    expect(confirmed).toContain(`### ${s.items.d1.shortId}`);
    expect(notConfirmed).toContain(`- ${s.items.r1.shortId} · ${revised}`);
  });

  it("answers not found for another org's engagement and items, and writes no usage for them", async () => {
    const { s, token } = await scenarioWithToken();
    const other = await createExportScenario(app, admin.db, { shortCode: "OTHR" });
    const client = await connect(token.token);
    for (const [tool, args] of [
      ["get_confirmed_spec", { engagement_id: other.engagementId }],
      ["get_confirmed_spec", { engagement_id: "OTHR" }],
      ["list_unconfirmed", { engagement_id: other.engagementId }],
      ["get_item", { item_id: other.items.r1.itemId }],
      ["get_item", { item_id: "OTHR-R1" }],
      ["get_item", { item_id: "HALV-R99" }],
    ] as const) {
      const result = await call(client, tool, args);
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/^Not found/);
      expect(result.text).not.toContain(other.engagementId);
    }
    const { engagements } = JSON.parse((await call(client, "list_engagements")).text) as { engagements: { id: string }[] };
    expect(engagements.map((e) => e.id)).toEqual([s.engagementId]);
    expect((await usageRows(s, token.id)).map((r) => r.tool)).toEqual(["list_engagements"]);
  });

  it("writes a usage_event per successful tool call", async () => {
    const { s, token } = await scenarioWithToken();
    const client = await connect(token.token);
    await call(client, "list_engagements");
    await call(client, "get_confirmed_spec", { engagement_id: "HALV" });
    await call(client, "get_item", { item_id: "HALV-R1" });
    await call(client, "list_unconfirmed", { engagement_id: "HALV" });
    const rows = await usageRows(s, token.id);
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row).toMatchObject({ orgId: s.orgId, kind: "mcp_fetch", userId: s.userId, apiTokenId: token.id });
    const engagementByTool = Object.fromEntries(rows.map((r) => [r.tool, r.engagementId]));
    expect(engagementByTool).toEqual({
      list_engagements: null,
      get_confirmed_spec: s.engagementId,
      get_item: s.engagementId,
      list_unconfirmed: s.engagementId,
    });
  });
});

describe("HTTP", () => {
  it("rejects missing, malformed, unknown and revoked tokens with 401 and a Bearer challenge", async () => {
    const { s, token } = await scenarioWithToken();
    const url = await sharedUrl;

    const missing = await post(url);
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe('Bearer realm="veradact"');
    expect(((await missing.json()) as { error: { message: string } }).error.message).toContain("Settings → API tokens");

    for (const bad of ["not-a-token", `vdt_${randomBytes(32).toString("base64url")}`]) {
      const response = await post(url, { token: bad });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe('Bearer realm="veradact", error="invalid_token"');
    }

    expect((await post(url, { token: token.token })).status).toBe(200);
    await revokeApiToken({ db: app.db, ctx: { orgId: s.orgId, userId: s.userId, role: "admin" }, clock: () => new Date(), tokenId: token.id });
    expect((await post(url, { token: token.token })).status).toBe(401);
    await expect(connect(token.token)).rejects.toThrow();
  });

  it("rate limits per token with 429 and Retry-After", async () => {
    const { token } = await scenarioWithToken();
    const url = await startServer({ clock: () => new Date("2026-06-01T12:00:10.000Z"), rateLimits: { perTokenPerMinute: 2, perIpPerMinute: 1000 } });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push(await post(url, { token: token.token }));
    expect(statuses.map((r) => r.status)).toEqual([200, 200, 429]);
    expect(statuses[2]!.headers.get("retry-after")).toBe("50");
  });

  it("rate limits per IP before authentication", async () => {
    const url = await startServer({ clock: () => new Date("2026-06-01T12:00:40.000Z"), rateLimits: { perTokenPerMinute: 1000, perIpPerMinute: 2 } });
    const ip = uniqueIp();
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await post(url, { ip })).status);
    expect(statuses).toEqual([401, 401, 429]);
    // Another address is unaffected.
    expect((await post(url)).status).toBe(401);
  });

  it("keys the per-IP limit on the address the trusted proxy appended, not on client-supplied entries", async () => {
    const url = await startServer({ clock: () => new Date("2026-06-01T12:01:40.000Z"), rateLimits: { perTokenPerMinute: 1000, perIpPerMinute: 2 } });
    const real = uniqueIp();
    // A client rotating a forged leftmost entry stays in the bucket of the address its proxy saw.
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await post(url, { ip: `${uniqueIp()}, ${real}` })).status);
    expect(statuses).toEqual([401, 401, 429]);
  });

  it("ignores X-Forwarded-For with zero trusted proxy hops and uses the socket address", async () => {
    const url = await startServer({ clock: () => new Date("2026-06-01T12:02:40.000Z"), rateLimits: { perTokenPerMinute: 1000, perIpPerMinute: 2 }, trustedProxyHops: 0 });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await post(url, { ip: uniqueIp() })).status);
    expect(statuses).toEqual([401, 401, 429]);
  });

  it("rejects request bodies over 1 MB with 413", async () => {
    const { token } = await scenarioWithToken();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(1024 * 1024) } });
    expect((await post(await sharedUrl, { token: token.token, body })).status).toBe(413);
  });

  it("answers 405 for GET/DELETE on /mcp, 404 elsewhere and 200 on /healthz", async () => {
    const url = await sharedUrl;
    for (const method of ["GET", "DELETE"]) {
      const response = await fetch(url, { method });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }
    expect((await fetch(new URL("/nope", url))).status).toBe(404);
    const health = await fetch(new URL("/healthz", url));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
  });
});
