import { describe, expect, it } from "vitest";
import { clientIpFrom, isHttpsRequest, userAgentFrom } from "./request";

const h = (values: Record<string, string>) => new Headers(values);

describe("request helpers", () => {
  it("takes the first x-forwarded-for entry, then x-real-ip", () => {
    expect(clientIpFrom(h({ "x-forwarded-for": " 203.0.113.7 , 10.0.0.1", "x-real-ip": "10.0.0.2" }))).toBe("203.0.113.7");
    expect(clientIpFrom(h({ "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4");
    expect(clientIpFrom(h({}))).toBe("unknown");
    expect(clientIpFrom(h({ "x-forwarded-for": " , " }))).toBe("unknown");
  });

  it("truncates user agents", () => {
    expect(userAgentFrom(h({ "user-agent": "x".repeat(600) }))).toHaveLength(512);
    expect(userAgentFrom(h({}))).toBeNull();
  });

  it("detects https from x-forwarded-proto or the URL", () => {
    expect(isHttpsRequest(h({ "x-forwarded-proto": "https" }), "http://localhost:3000")).toBe(true);
    expect(isHttpsRequest(h({ "x-forwarded-proto": "http" }), "https://app.example.com")).toBe(false);
    expect(isHttpsRequest(h({}), "https://app.example.com")).toBe(true);
    expect(isHttpsRequest(h({}), "http://localhost:3000")).toBe(false);
  });
});
