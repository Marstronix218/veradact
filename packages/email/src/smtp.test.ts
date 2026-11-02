import { describe, expect, it, vi } from "vitest";
import { EmailDeliveryError } from "./errors";
import { SmtpEmailProvider } from "./smtp";

const msg = { to: "ada@example.test", subject: "Secret subject", text: "Secret body https://app.test/c/tok" };
const from = "Veradact <no-reply@veradact.local>";

describe("SmtpEmailProvider", () => {
  it("sends from EMAIL_FROM and returns the transport message id", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "<abc@veradact.local>" });
    const mail = new SmtpEmailProvider({ url: "smtp://localhost:25", from, transport: { sendMail } });

    await expect(mail.send({ ...msg, html: "<p>hi</p>", tags: { k: "v" } })).resolves.toEqual({
      id: "<abc@veradact.local>",
    });
    expect(mail.name).toBe("smtp");
    expect(sendMail).toHaveBeenCalledWith({
      from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: "<p>hi</p>",
    });
  });

  it("omits html when there is none", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "<x@y>" });
    await new SmtpEmailProvider({ url: "smtp://localhost:25", from, transport: { sendMail } }).send(msg);
    expect(sendMail.mock.calls[0]?.[0]).not.toHaveProperty("html");
  });

  it("rethrows failures as EmailDeliveryError carrying a code only", async () => {
    const leaky = Object.assign(new Error(`550 5.1.1 <${msg.to}> rejected: ${msg.text}`), {
      code: "EENVELOPE",
      response: `550 ${msg.to}`,
      command: "RCPT TO",
    });
    const mail = new SmtpEmailProvider({
      url: "smtp://localhost:25",
      from,
      transport: { sendMail: vi.fn().mockRejectedValue(leaky) },
    });

    const err = await mail.send(msg).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EmailDeliveryError);
    expect(err).toMatchObject({ name: "EmailDeliveryError", code: "EENVELOPE" });
    expect((err as Error).cause).toBeUndefined();
    const serialized = `${String(err)} ${(err as Error).stack} ${JSON.stringify(err)}`;
    for (const secret of [msg.to, msg.subject, "Secret body", "app.test", "RCPT"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it.each([
    [{ code: "ETIMEDOUT" }, "ETIMEDOUT"],
    [{ code: "EAUTH" }, "EAUTH"],
    [{ code: "ECONNREFUSED" }, "EUNKNOWN"],
    [{ code: 42 }, "EUNKNOWN"],
    [new Error("boom"), "EUNKNOWN"],
    ["string failure", "EUNKNOWN"],
    [null, "EUNKNOWN"],
  ])("maps %j to %s", async (thrown, code) => {
    const mail = new SmtpEmailProvider({
      url: "smtp://localhost:25",
      from,
      transport: { sendMail: vi.fn().mockRejectedValue(thrown) },
    });
    await expect(mail.send(msg)).rejects.toMatchObject({ code });
  });

  it("rejects recipient lists before touching the transport", async () => {
    const sendMail = vi.fn();
    const mail = new SmtpEmailProvider({ url: "smtp://localhost:25", from, transport: { sendMail } });
    await expect(mail.send({ ...msg, to: "a@x.test, victim@y.test" })).rejects.toMatchObject({ code: "EENVELOPE" });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("maps a real connection failure to a code without leaking the recipient", async () => {
    // Port 1 on localhost: nothing listens, connection is refused immediately.
    const mail = new SmtpEmailProvider({ url: "smtp://127.0.0.1:1", from });
    const err = await mail.send(msg).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmailDeliveryError);
    expect(String(err)).toMatch(/^EmailDeliveryError: Email delivery failed \(E[A-Z]+\)$/);
    expect(String(err)).not.toContain(msg.to);
  });
});
