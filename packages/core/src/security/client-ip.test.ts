import { describe, expect, it } from "vitest";
import { clientIpFromForwardedFor, trustedProxyHops } from "./client-ip";

describe("clientIpFromForwardedFor", () => {
  it("takes the entry written by the first trusted proxy, ignoring what the client prepended", () => {
    // The client sent "X-Forwarded-For: 192.0.2.66"; the one trusted proxy appended the real address.
    expect(clientIpFromForwardedFor("192.0.2.66, 203.0.113.7", 1, "unknown")).toBe("203.0.113.7");
    // CDN + load balancer: the CDN saw the client, the load balancer saw the CDN.
    expect(clientIpFromForwardedFor("192.0.2.66, 203.0.113.7, 10.0.0.5", 2, "unknown")).toBe("203.0.113.7");
    expect(clientIpFromForwardedFor(" 203.0.113.7 ", 1, "unknown")).toBe("203.0.113.7");
    // Fewer entries than hops: the leftmost is the best we have.
    expect(clientIpFromForwardedFor("203.0.113.7", 3, "unknown")).toBe("203.0.113.7");
  });

  it("falls back when there is no proxy or no usable header", () => {
    expect(clientIpFromForwardedFor("192.0.2.66", 0, "198.51.100.4")).toBe("198.51.100.4");
    expect(clientIpFromForwardedFor(null, 1, "198.51.100.4")).toBe("198.51.100.4");
    expect(clientIpFromForwardedFor(" , ", 1, "unknown")).toBe("unknown");
  });
});

describe("trustedProxyHops", () => {
  it("defaults to one proxy and accepts 0 to 10", () => {
    expect(trustedProxyHops({})).toBe(1);
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: " " })).toBe(1);
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: "0" })).toBe(0);
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: "2" })).toBe(2);
  });

  it("rejects anything else", () => {
    for (const value of ["-1", "1.5", "two", "11", "0x1"]) {
      expect(() => trustedProxyHops({ TRUSTED_PROXY_HOPS: value })).toThrow(/TRUSTED_PROXY_HOPS/);
    }
  });
});
