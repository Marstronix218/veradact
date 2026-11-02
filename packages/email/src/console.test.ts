import { describe, expect, it, vi } from "vitest";
import { ConsoleEmailProvider } from "./console";

function capture() {
  const chunks: string[] = [];
  return { write: (c: string) => void chunks.push(c), output: () => chunks.join("") };
}

describe("ConsoleEmailProvider", () => {
  it("prints the full message so links can be clicked", async () => {
    const out = capture();
    const mail = new ConsoleEmailProvider({ write: out.write, nodeEnv: "development" });

    const { id } = await mail.send({
      to: "ada@example.test",
      subject: "Confirm your items",
      text: "Open http://localhost:3000/c/v1.abc.123.sig to review.",
      html: "<a href='http://localhost:3000/c/v1.abc.123.sig'>review</a>",
      tags: { kind: "confirmation_request" },
    });

    expect(mail.name).toBe("console");
    expect(id).toMatch(/^console-/);
    const text = out.output();
    expect(text).toContain(id);
    expect(text).toContain("ada@example.test");
    expect(text).toContain("Confirm your items");
    expect(text).toContain("http://localhost:3000/c/v1.abc.123.sig to review.");
    expect(text).toContain("<a href=");
    expect(text).toContain("kind=confirmation_request");
  });

  it("writes to stdout by default", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await new ConsoleEmailProvider({ nodeEnv: "test" }).send({ to: "a@example.test", subject: "s", text: "t" });
      expect(write.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("a@example.test");
    } finally {
      write.mockRestore();
    }
  });

  it("refuses to be constructed in production", () => {
    expect(() => new ConsoleEmailProvider({ nodeEnv: "production" })).toThrow(/production/);
  });

  it("allows production only with allowInProduction", async () => {
    const out = capture();
    const mail = new ConsoleEmailProvider({ nodeEnv: "production", allowInProduction: true, write: out.write });
    await mail.send({ to: "a@example.test", subject: "s", text: "t" });
    expect(out.output()).toContain("a@example.test");
  });

  it("reads NODE_ENV from the process when not given", () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => new ConsoleEmailProvider()).toThrow(/production/);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it("rejects a recipient list", async () => {
    const out = capture();
    const mail = new ConsoleEmailProvider({ write: out.write, nodeEnv: "test" });
    await expect(mail.send({ to: "a@x.test,b@y.test", subject: "s", text: "t" })).rejects.toMatchObject({
      code: "EENVELOPE",
    });
    expect(out.output()).toBe("");
  });
});
