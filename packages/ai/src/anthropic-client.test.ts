import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AnthropicModelClient,
  DEFAULT_MAX_TOKENS,
  RECORD_CANDIDATES_TOOL_NAME,
  supportsForcedToolChoice,
  type AnthropicModelClientOptions,
} from "./anthropic-client";
import { ModelClientError, type ExtractionInput, type RawCandidate } from "./model-client";
import { loadPrompt } from "./prompts";
import { verifyCandidates } from "./verify";

// No network: a real SDK client whose transport (`fetch`) is a fake that records request
// bodies and answers with canned Messages API responses.

type Body = Anthropic.MessageCreateParamsNonStreaming;
type Reply = { status?: number; json: unknown };

function fakeSdk(reply: (body: Body, call: number) => Reply) {
  const requests: Body[] = [];
  const fetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as Body;
    requests.push(body);
    const { status = 200, json } = reply(body, requests.length - 1);
    return new Response(JSON.stringify(json), {
      status,
      headers: { "content-type": "application/json", "request-id": `req_${requests.length}` },
    });
  };
  const client = new Anthropic({ apiKey: "test-key", fetch, maxRetries: 0 });
  return { client, requests };
}

function message(content: unknown[], stop_reason = "tool_use") {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "test-model",
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 45 },
  };
}

const toolUse = (input: unknown) => ({ type: "tool_use", id: "toolu_test", name: RECORD_CANDIDATES_TOOL_NAME, input });

function candidate(over: Partial<RawCandidate>): RawCandidate {
  return {
    kind: "requirement",
    statement: "A statement.",
    quote: "",
    start: 0,
    end: 0,
    speaker_label: null,
    confidence: 0.8,
    suggested_depends_on: [],
    revises: null,
    ...over,
  };
}

/** The source text the client put between <source> tags. */
function sourceOf(body: Body): string {
  const first = body.messages[0];
  const content = typeof first?.content === "string" ? first.content : "";
  const m = /<source>\n([\s\S]*)\n<\/source>/.exec(content);
  if (!m?.[1]) throw new Error("no <source> block in request");
  return m[1];
}

const SOURCE = [
  "Dana Whitcombe: The early shift in Columbus moved to 5:30.",
  "Lena Sorensen: Route suggestions need to be ready by 5:00 a.m.",
  "Marcus Oyelaran: Only Halvorsen IT can approve new integrations.",
].join("\n");

const input = (over: Partial<ExtractionInput> = {}): ExtractionInput => ({
  sourceText: SOURCE,
  sourceType: "machine_transcript",
  existingItems: [{ short_id: "HALV-C1", kind: "constraint", status: "confirmed", statement: "Data stays in Ohio." }],
  promptVersion: "extract.v1",
  ...over,
});

function make(reply: (body: Body, call: number) => Reply, options: AnthropicModelClientOptions = {}) {
  const sdk = fakeSdk(reply);
  const events: [string, Record<string, unknown>][] = [];
  const client = new AnthropicModelClient({
    model: "claude-sonnet-5",
    client: sdk.client,
    log: (event, fields) => events.push([event, fields]),
    ...options,
  });
  return { client, requests: sdk.requests, events };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("AnthropicModelClient request", () => {
  it("forces the record_candidates tool on models that allow it, with explicit max_tokens and the versioned prompt", async () => {
    const quote = "Only Halvorsen IT can approve new integrations";
    const { client, requests } = make((body) => {
      const start = sourceOf(body).indexOf(quote);
      return { json: message([toolUse({ candidates: [candidate({ kind: "constraint", quote, start, end: start + quote.length })] })]) };
    });

    const out = await client.extract(input());
    expect(requests).toHaveLength(1);
    const body = requests[0];
    if (!body) throw new Error("no request");
    expect(body.model).toBe("claude-sonnet-5");
    expect(body.max_tokens).toBe(DEFAULT_MAX_TOKENS);
    expect(body.tool_choice).toEqual({ type: "tool", name: "record_candidates", disable_parallel_tool_use: true });
    expect(body.tools).toHaveLength(1);
    const tool = body.tools?.[0] as Anthropic.Tool;
    expect(tool.name).toBe("record_candidates");
    expect(tool.strict).toBe(true);
    expect(tool.input_schema.required).toEqual(["candidates"]);
    expect(body.system).toEqual([{ type: "text", text: loadPrompt("extract", "v1").text, cache_control: { type: "ephemeral" } }]);
    expect(sourceOf(body)).toBe(SOURCE);
    const user = body.messages[0]?.content as string;
    expect(user).toContain("Source type: machine_transcript");
    expect(user).toContain('"short_id":"HALV-C1"');
    expect(body).not.toHaveProperty("temperature");

    expect(out).toHaveLength(1);
    expect(verifyCandidates(SOURCE, out).accepted[0]?.verification).toBe("exact");
  });

  it("uses ANTHROPIC_MODEL and tool_choice auto on models that reject forced tool use, retrying once without a tool call", async () => {
    vi.stubEnv("ANTHROPIC_MODEL", "claude-sonnet-5-5");
    const { client, requests, events } = make(
      (_body, call) =>
        call === 0
          ? { json: message([{ type: "text", text: "Here are the items." }], "end_turn") }
          : { json: message([toolUse({ candidates: [] })]) },
      { model: undefined },
    );
    expect(client.name).toBe("claude-sonnet-5-5");
    await expect(client.extract(input())).resolves.toEqual([]);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.model).toBe("claude-sonnet-5-5");
    expect(requests[0]?.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect((requests[0]?.tools?.[0] as Anthropic.Tool).strict).toBe(true);
    expect(events.map(([e]) => e)).toContain("ai.extract.no_tool_call");
  });

  it("gives up with no_tool_call after the retry", async () => {
    const { client, requests } = make(() => ({ json: message([{ type: "text", text: "none" }], "end_turn") }), {
      model: "claude-opus-5-5",
    });
    await expect(client.extract(input())).rejects.toMatchObject({ code: "no_tool_call" });
    expect(requests).toHaveLength(2);
  });

  it("chunks long sources on line boundaries and re-bases offsets and #n references", async () => {
    const lines = Array.from({ length: 9 }, (_, i) => `Speaker ${i}: requirement number ${i} is stated here.`);
    const text = lines.join("\n");
    const { client, requests } = make((body) => {
      const chunk = sourceOf(body);
      // one candidate per line in the chunk, offsets relative to the chunk; each depends on the previous one
      const candidates = chunk.split("\n").filter(Boolean).map((line, i) => {
        const quote = line.slice(line.indexOf(": ") + 2);
        const start = chunk.indexOf(quote);
        return candidate({ quote, start, end: start + quote.length, suggested_depends_on: i > 0 ? [`#${i}`] : ["HALV-C1"] });
      });
      return { json: message([toolUse({ candidates })]) };
    }, { maxChunkChars: 150 });

    const out = await client.extract(input({ sourceText: text }));
    expect(requests.length).toBeGreaterThan(2);
    for (const r of requests) expect(sourceOf(r).length).toBeLessThanOrEqual(150);
    expect(requests.map(sourceOf).join("")).toBe(text); // chunks are the source, split right after newlines
    expect(requests[1]?.messages[0]?.content).toMatch(/part 2 of \d+/);

    expect(out).toHaveLength(9);
    const verified = verifyCandidates(text, out);
    expect(verified.counts).toMatchObject({ accepted: 9, exact: 9, corrected: 0, dropped: 0 });
    // every candidate after the first chunk's first one points at the candidate before it (global ordinals)
    const firstOfChunk = new Set<number>();
    let seen = 0;
    for (const r of requests) {
      firstOfChunk.add(seen);
      seen += sourceOf(r).split("\n").filter(Boolean).length;
    }
    out.forEach((c, i) => {
      expect(c.suggested_depends_on).toEqual(firstOfChunk.has(i) ? ["HALV-C1"] : [`#${i}`]);
    });
  });

  it("skips whitespace-only chunks", async () => {
    const { client, requests } = make(() => ({ json: message([toolUse({ candidates: [] })]) }), { maxChunkChars: 10 });
    await client.extract(input({ sourceText: "short\n\n\n\n\n\n\n\n\n\n\n\n\n\nline" }));
    expect(requests.map((r) => sourceOf(r).trim())).toEqual(["short", "line"]);
  });
});

describe("AnthropicModelClient errors", () => {
  const SECRET = "Only Halvorsen IT can approve";

  it.each([
    [400, "invalid_request_error", "bad_request", false],
    [401, "authentication_error", "auth_failed", false],
    [403, "permission_error", "permission_denied", false],
    [404, "not_found_error", "not_found", false],
    [429, "rate_limit_error", "rate_limited", true],
    [500, "api_error", "server_error", true],
    [529, "overloaded_error", "overloaded", true],
  ])("maps HTTP %i to %s without echoing provider text", async (status, type, code, retryable) => {
    const { client, events } = make(() => ({ status, json: { type: "error", error: { type, message: `echo: ${SECRET}` } } }));
    const err = await client.extract(input()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelClientError);
    expect(err).toMatchObject({ code, retryable, status });
    expect((err as ModelClientError).requestId).toBe("req_1");
    expect(String((err as Error).message)).not.toContain(SECRET);
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });

  it("maps a transport failure to connection_failed", async () => {
    const sdk = new Anthropic({
      apiKey: "k",
      maxRetries: 0,
      fetch: async () => {
        throw new TypeError(`socket hang up near ${SECRET}`);
      },
    });
    const client = new AnthropicModelClient({ model: "claude-sonnet-5", client: sdk });
    const err = await client.extract(input()).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "connection_failed", retryable: true });
    expect(String((err as Error).message)).not.toContain(SECRET);
  });

  it.each([
    ["refusal", "refused"],
    ["max_tokens", "output_truncated"],
    ["model_context_window_exceeded", "context_exceeded"],
  ])("stop_reason %s → %s", async (stop, code) => {
    const { client } = make(() => ({ json: message([toolUse({ candidates: [] })], stop) }));
    await expect(client.extract(input())).rejects.toMatchObject({ code });
  });

  it("rejects tool input that does not match the candidate schema", async () => {
    const { client } = make(() => ({ json: message([toolUse({ candidates: [{ kind: "decision", quote: 3 }] })]) }));
    await expect(client.extract(input())).rejects.toMatchObject({ code: "invalid_output" });
  });

  it("fails with missing_api_key before any request when no key is configured", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const client = new AnthropicModelClient({ model: "claude-sonnet-5" });
    await expect(client.extract(input())).rejects.toMatchObject({ code: "missing_api_key" });
  });

  it("logs ids and counts only — never source text, quotes or statements", async () => {
    const quote = "Route suggestions need to be ready by 5:00 a.m.";
    const { client, events } = make((body) => {
      const start = sourceOf(body).indexOf(quote);
      return { json: message([toolUse({ candidates: [candidate({ quote, start, end: start + quote.length, statement: "Suggestions ready at 5." })] })]) };
    });
    await client.extract(input());
    expect(events.map(([e]) => e)).toEqual(["ai.extract.chunk", "ai.extract.done"]);
    const logged = JSON.stringify(events);
    for (const line of SOURCE.split("\n")) expect(logged).not.toContain(line.slice(0, 20));
    expect(logged).not.toContain("Suggestions ready");
    for (const [, fields] of events) {
      for (const v of Object.values(fields)) expect(["string", "number", "boolean"].includes(typeof v) || v === null).toBe(true);
    }
  });
});

describe("supportsForcedToolChoice", () => {
  it.each([
    ["claude-sonnet-5-5", false],
    ["claude-opus-5-5", false],
    ["claude-fable-5-1", false],
    ["claude-mythos-5-1", false],
    ["anthropic.claude-sonnet-5-5", false],
    ["claude-sonnet-5", true],
    ["claude-opus-5", true],
    ["claude-haiku-5-5", true],
    ["claude-opus-4-8", true],
  ])("%s → %s", (model, expected) => {
    expect(supportsForcedToolChoice(model)).toBe(expected);
  });
});
