import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const core = vi.hoisted(() => ({ logout: vi.fn() }));

vi.mock("@veradact/core", async (importOriginal) => ({ ...(await importOriginal<typeof import("@veradact/core")>()), ...core }));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/env", () => ({ appUrl: () => "http://veradact.test" }));

const { POST } = await import("./route");

beforeEach(() => {
  vi.clearAllMocks();
  core.logout.mockResolvedValue(undefined);
});

describe("POST /logout", () => {
  it("clears the session and redirects to the landing page", async () => {
    const request = new NextRequest("http://veradact.test/logout", {
      method: "POST",
      headers: { cookie: "vd_session=session-token" },
    });

    const response = await POST(request);

    expect(core.logout).toHaveBeenCalledWith(expect.objectContaining({ token: "session-token" }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://veradact.test/");
    expect(response.cookies.get("vd_session")?.value).toBe("");
  });
});
