import { afterEach, describe, expect, it, vi } from "vitest";
import { clientIpFrom, isCrossSite, readFormData, userAgentFrom } from "./request";

const h = (values: Record<string, string>) => new Headers(values);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("request helpers", () => {
  it("takes the X-Forwarded-For entry of the first trusted proxy (default one hop)", () => {
    // A client-supplied entry on the left is ignored; the proxy appended the real address.
    expect(clientIpFrom(h({ "x-forwarded-for": "192.0.2.66, 203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientIpFrom(h({ "x-forwarded-for": " 203.0.113.7 " }))).toBe("203.0.113.7");
    expect(clientIpFrom(h({ "x-real-ip": "198.51.100.4" }))).toBe("unknown");
    expect(clientIpFrom(h({}))).toBe("unknown");
    expect(clientIpFrom(h({ "x-forwarded-for": " , " }))).toBe("unknown");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "2");
    expect(clientIpFrom(h({ "x-forwarded-for": "192.0.2.66, 203.0.113.7, 10.0.0.5" }))).toBe("203.0.113.7");
    // No proxy: the header is client-controlled, so it is ignored.
    vi.stubEnv("TRUSTED_PROXY_HOPS", "0");
    expect(clientIpFrom(h({ "x-forwarded-for": "203.0.113.7" }))).toBe("unknown");
  });

  it("truncates user agents", () => {
    expect(userAgentFrom(h({ "user-agent": "x".repeat(600) }))).toHaveLength(512);
    expect(userAgentFrom(h({}))).toBeNull();
  });

  it("treats only same-origin form posts as same-site", () => {
    const app = "http://localhost:3000";
    expect(isCrossSite(h({ "sec-fetch-site": "same-origin", origin: "null" }), app)).toBe(false);
    for (const site of ["cross-site", "same-site", "none"]) expect(isCrossSite(h({ "sec-fetch-site": site }), app)).toBe(true);
    // Without Fetch Metadata (older browsers) the Origin decides.
    expect(isCrossSite(h({ origin: app }), app)).toBe(false);
    expect(isCrossSite(h({ origin: "https://evil.example" }), app)).toBe(true);
    expect(isCrossSite(h({ origin: "null" }), app)).toBe(true);
    expect(isCrossSite(h({ origin: "null" }), app, { allowNullOrigin: true })).toBe(false);
    // Not a browser: nothing to forge on someone's behalf.
    expect(isCrossSite(h({}), app)).toBe(false);
  });

  it("reads small forms and refuses oversized ones by declared and by actual length", async () => {
    const post = (body: string, headers: Record<string, string> = {}) =>
      new Request("http://localhost/x", { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded", ...headers } });
    expect((await readFormData(post("token=abc&x=1"), 100))?.get("token")).toBe("abc");
    expect(await readFormData(post("token=abc", { "content-length": "5000" }), 100)).toBeNull();
    expect(await readFormData(post(`token=${"a".repeat(200)}`), 100)).toBeNull();
  });
});
