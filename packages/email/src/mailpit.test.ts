import { afterEach, describe, expect, it, vi } from "vitest";
import { extractFirstLink, isMailpitReachable, mailpitClear, mailpitLatestTo } from "./mailpit";

const BASE = "http://mailpit.test:8025";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function summary(id: string, to: string, created: string) {
  return { ID: id, Created: created, To: [{ Name: "", Address: to }] };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("extractFirstLink", () => {
  const text = [
    "Hi,",
    "Docs: https://example.test/help/start.",
    "Review your items: http://localhost:3000/c/v1.abc_-.1780000000.sig-_9.",
    "Sign in: http://localhost:3000/auth/verify?token=abc%2B123&next=%2F (expires soon)",
  ].join("\r\n");

  it("extracts the first link under a path prefix and drops trailing prose punctuation", () => {
    expect(extractFirstLink(text, "/c/")).toBe("http://localhost:3000/c/v1.abc_-.1780000000.sig-_9");
  });

  it("matches the path plus query, so query-bearing routes work", () => {
    expect(extractFirstLink(text, "/auth/verify")).toBe(
      "http://localhost:3000/auth/verify?token=abc%2B123&next=%2F",
    );
    expect(extractFirstLink(text, "/auth/verify?token=")).toContain("token=abc%2B123");
  });

  it("returns the first of several matches", () => {
    expect(extractFirstLink("http://a.test/c/1 http://a.test/c/2", "/c/")).toBe("http://a.test/c/1");
  });

  it("throws without quoting the text (it carries tokens)", () => {
    let message = "";
    try {
      extractFirstLink("see http://a.test/other/SECRET-TOKEN", "/c/");
    } catch (err) {
      message = String(err);
    }
    expect(message).toMatch(/\/c\//);
    expect(message).not.toContain("SECRET-TOKEN");
  });
});

describe("mailpitLatestTo", () => {
  it("polls until a message to the exact address arrives, then returns its content", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ messages: [] }))
      .mockResolvedValueOnce(
        json({
          messages: [
            summary("other", "bob@example.test", "2026-01-01T00:00:03Z"),
            summary("old", "Ada@Example.test", "2026-01-01T00:00:01Z"),
            summary("new", "ada@example.test", "2026-01-01T00:00:02Z"),
          ],
        }),
      )
      .mockResolvedValueOnce(json({ ID: "new", Subject: "Hi", Text: "plain", HTML: "<p>rich</p>" }));
    vi.stubGlobal("fetch", fetchMock);

    const msg = await mailpitLatestTo("ada@example.test", { baseUrl: `${BASE}/`, pollIntervalMs: 1, timeoutMs: 1_000 });

    expect(msg).toEqual({ subject: "Hi", text: "plain", html: "<p>rich</p>" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const searchUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(searchUrl.origin + searchUrl.pathname).toBe(`${BASE}/api/v1/search`);
    expect(searchUrl.searchParams.get("query")).toBe('to:"ada@example.test"');
    expect(String(fetchMock.mock.calls[2]?.[0])).toBe(`${BASE}/api/v1/message/new`);
  });

  it("does not match a different address that merely contains the query", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ messages: [summary("m", "grace@example.test", "2026-01-01T00:00:00Z")] })),
    );
    await expect(
      mailpitLatestTo("race@example.test", { baseUrl: BASE, pollIntervalMs: 1, timeoutMs: 30 }),
    ).rejects.toThrow(/No matching message/);
  });

  it("honours `since`", async () => {
    const messages = [
      summary("late", "ada@example.test", "2026-01-01T00:00:10Z"),
      summary("early", "ada@example.test", "2026-01-01T00:00:01Z"),
    ];
    const fetchMock = vi.fn<typeof fetch>(async (input) =>
      String(input).includes("/search")
        ? json({ messages })
        : json({ Subject: String(input).split("/").pop(), Text: "", HTML: "" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const afterEarly = await mailpitLatestTo("ada@example.test", {
      baseUrl: BASE,
      since: new Date("2026-01-01T00:00:05Z"),
    });
    expect(afterEarly.subject).toBe("late");

    await expect(
      mailpitLatestTo("ada@example.test", {
        baseUrl: BASE,
        since: Date.parse("2026-01-01T00:00:11Z"),
        pollIntervalMs: 1,
        timeoutMs: 30,
      }),
    ).rejects.toThrow(/No matching message/);
  });

  it("times out without leaking the recipient", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ messages: [] })));
    const err = await mailpitLatestTo("secret.person@example.test", {
      baseUrl: BASE,
      pollIntervalMs: 1,
      timeoutMs: 20,
    }).catch((e: unknown) => e);
    expect(String(err)).toMatch(/within 20 ms/);
    expect(String(err)).not.toContain("secret.person");
  });

  it("reports an unreachable Mailpit distinctly after the timeout", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    await expect(
      mailpitLatestTo("ada@example.test", { baseUrl: BASE, pollIntervalMs: 1, timeoutMs: 20 }),
    ).rejects.toThrow(/unreachable at http:\/\/mailpit\.test:8025/);
  });

  it("fails fast on an HTTP error from Mailpit", async () => {
    const fetchMock = vi.fn(async () => json({ error: "nope" }, 500));
    vi.stubGlobal("fetch", fetchMock);
    await expect(mailpitLatestTo("ada@example.test", { baseUrl: BASE, timeoutMs: 5_000 })).rejects.toThrow(/HTTP 500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("defaults to MAILPIT_URL, then to localhost:54332", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json({ messages: [] }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("MAILPIT_URL", "http://from-env.test:1");
    await mailpitLatestTo("a@example.test", { timeoutMs: 0 }).catch(() => undefined);
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/^http:\/\/from-env\.test:1\/api\/v1\/search/);

    vi.stubEnv("MAILPIT_URL", "");
    fetchMock.mockClear();
    await mailpitLatestTo("a@example.test", { timeoutMs: 0 }).catch(() => undefined);
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/^http:\/\/localhost:54332\/api\/v1\/search/);
  });
});

describe("mailpitClear / isMailpitReachable", () => {
  it("DELETEs all messages", async () => {
    // Real Mailpit replies to DELETE with plain text, not JSON.
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    await mailpitClear({ baseUrl: BASE });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${BASE}/api/v1/messages`);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("DELETE");
  });

  it("mailpitClear surfaces HTTP failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({}, 503)));
    await expect(mailpitClear({ baseUrl: BASE })).rejects.toThrow(/HTTP 503/);
  });

  it("reports reachability", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ Version: "v1" })));
    await expect(isMailpitReachable({ baseUrl: BASE })).resolves.toBe(true);
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    await expect(isMailpitReachable({ baseUrl: BASE })).resolves.toBe(false);
  });
});
