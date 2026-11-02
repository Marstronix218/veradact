import { describe, expect, it } from "vitest";
import type { ConfirmationDelivery } from "./channels";
import type { ClientReceipt } from "./client-actions";
import { confirmationLinkEmail, declineNotificationEmail, disputeNotificationEmail, escapeHtml, receiptEmail } from "./emails";

const delivery: ConfirmationDelivery = {
  kind: "request",
  url: "https://app.example/c/v1.abc",
  link: { id: "3b1f6c1e-1d2a-4c3b-9a8e-7f6d5c4b3a21", expiresAt: new Date("2026-11-13T17:00:00.000Z") },
  contact: { id: "9a8e7f6d-5c4b-4a21-8b1f-6c1e1d2a4c3b", name: "Ada <b>Client</b>", email: "ada@client.example" },
  request: { id: "1d2a4c3b-9a8e-4f6d-8c4b-3a213b1f6c1e", itemCount: 1 },
  engagement: { id: "4c3b9a8e-7f6d-4c4b-8a21-3b1f6c1e1d2a", name: "Dispatch & billing", clientName: "Halvorsen Freight", timeZone: "America/New_York" },
  vendorName: "Quillfield Labs",
  requesterName: "Morgan Member",
};

describe("confirmation emails", () => {
  it("escapes HTML", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  });

  it("link email: who asks, engagement, item count, link and expiry; escaped HTML without images or remote resources", () => {
    const m = confirmationLinkEmail(delivery);
    expect(m.to).toBe("ada@client.example");
    expect(m.subject).toBe("Quillfield Labs asks you to confirm 1 item for Dispatch & billing");
    expect(m.text).toContain('Morgan Member at Quillfield Labs asks you to confirm 1 item recorded for "Dispatch & billing".');
    expect(m.text).toContain("https://app.example/c/v1.abc");
    expect(m.text).toContain("expires on Friday, November 13, 2026");
    expect(m.html).toContain("Ada &lt;b&gt;Client&lt;/b&gt;");
    expect(m.html).toContain("Dispatch &amp; billing");
    expect(m.html).not.toMatch(/<img|<script|src=|<link/i);
    expect(m.tags).toEqual({ kind: "confirmation_request", request_id: delivery.request.id });

    const reminder = confirmationLinkEmail({ ...delivery, kind: "reminder", request: { ...delivery.request, itemCount: 3 } });
    expect(reminder.subject).toBe("Reminder: Quillfield Labs is waiting for you to confirm 3 items");
    expect(reminder.tags?.kind).toBe("confirmation_reminder");
  });

  it("receipt lists each item's decision, version and content hash plus the log head", () => {
    const receipt: ClientReceipt = {
      submissionId: "5c4b3a21-3b1f-4c1e-8d2a-4c3b9a8e7f6d",
      engagementName: "Dispatch",
      clientName: "Halvorsen Freight",
      vendorName: "Quillfield Labs",
      contactName: "Ada",
      timeZone: "America/New_York",
      recordedAt: new Date("2026-11-02T15:04:00.000Z"),
      items: [{ itemId: "x", shortId: "HALV-R1", kind: "requirement", statement: "<Refresh> every 5 min", decision: "confirmed", version: 2, contentHash: "a".repeat(64) }],
      head: { seq: 42, hash: "b".repeat(64) },
    };
    const m = receiptEmail(receipt, "ada@client.example");
    expect(m.text).toContain("HALV-R1 · Confirmed · version 2");
    expect(m.text).toContain(`Content hash: ${"a".repeat(64)}`);
    expect(m.text).toContain(`entry 42, hash ${"b".repeat(64)}`);
    expect(m.text).toContain("recorded on Nov 2, 2026, 10:04 AM EST");
    expect(m.html).toContain("&lt;Refresh&gt;");
  });

  it("vendor notices name the items but carry no comment", () => {
    const base = { to: "m@vendor.example", requesterName: "Morgan", contactName: "Ada", engagementName: "Dispatch", url: "https://app.example/engagements/e/confirmations" };
    expect(disputeNotificationEmail({ ...base, shortIds: ["HALV-R1", "HALV-A2"] }).subject).toBe("Ada disputed 2 items in Dispatch");
    expect(declineNotificationEmail(base).text).toContain("https://app.example/engagements/e/confirmations");
  });
});
