import { describe, expect, it } from "vitest";
import { EmailDeliveryError } from "./errors";
import { MemoryEmailProvider } from "./memory";

const msg = { to: "ada@example.test", subject: "Hello", text: "Body", tags: { kind: "magic_link" } };

describe("MemoryEmailProvider", () => {
  it("records sent messages in order and returns unique ids", async () => {
    const mail = new MemoryEmailProvider();
    const a = await mail.send(msg);
    const b = await mail.send({ ...msg, subject: "Second" });

    expect(mail.name).toBe("memory");
    expect(a.id).not.toBe(b.id);
    expect(mail.messages.map((m) => m.subject)).toEqual(["Hello", "Second"]);
    expect(mail.messages[0]).toEqual({ ...msg, id: a.id });
  });

  it("lastTo returns the newest message for an address, case-insensitively", async () => {
    const mail = new MemoryEmailProvider();
    await mail.send({ ...msg, subject: "old" });
    await mail.send({ ...msg, to: "bob@example.test", subject: "other" });
    await mail.send({ ...msg, to: "ADA@example.test", subject: "new" });

    expect(mail.lastTo("ada@example.test")?.subject).toBe("new");
    expect(mail.lastTo("bob@example.test")?.subject).toBe("other");
    expect(mail.lastTo("nobody@example.test")).toBeUndefined();
  });

  it("clear empties the store", async () => {
    const mail = new MemoryEmailProvider();
    await mail.send(msg);
    mail.clear();
    expect(mail.messages).toEqual([]);
    expect(mail.lastTo(msg.to)).toBeUndefined();
  });

  it("isolates stored messages from caller mutation and from the messages snapshot", async () => {
    const mail = new MemoryEmailProvider();
    const input = { ...msg, tags: { kind: "a" } };
    await mail.send(input);
    input.tags.kind = "changed";
    (mail.messages as unknown[]).length = 0;

    expect(mail.messages).toHaveLength(1);
    expect(mail.messages[0]?.tags).toEqual({ kind: "a" });
  });

  it.each(["a@x.test, b@y.test", "Ada <ada@example.test>", "ada@example.test\nBcc: x@y.test", "nobody", ""])(
    "rejects a recipient that is not a single plain address: %j",
    async (to) => {
      const mail = new MemoryEmailProvider();
      await expect(mail.send({ ...msg, to })).rejects.toMatchObject({
        name: "EmailDeliveryError",
        code: "EENVELOPE",
      });
      await expect(mail.send({ ...msg, to })).rejects.toBeInstanceOf(EmailDeliveryError);
      expect(mail.messages).toEqual([]);
    },
  );
});
