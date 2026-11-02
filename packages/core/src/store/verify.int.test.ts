// `verifyEngagementChain` under concurrent appends: at READ COMMITTED every statement sees the latest
// commits, so an append that lands between the head read and the events read must not make an
// untampered log look `truncated` (the head is read first and only grows).
import { afterAll, describe, expect, it } from "vitest";
import { event, withTenant, type Tx } from "@veradact/db";
import { adminTestDb, testDb } from "@veradact/db/testing";
import { createItem } from "../commands/items";
import { verifyChain } from "../domain";
import { createLedgerEngagement } from "../test-support/ledger";
import { readEngagementHead, readEvents, verifyEngagementChain } from "./index";

const app = testDb();
const admin = adminTestDb();

afterAll(async () => {
  await Promise.all([app.close(), admin.close()]);
});

type AnyFn = (...args: unknown[]) => unknown;

/**
 * Wraps a transaction so that `hook` runs once, right before or right after the first query on the
 * `event` table: the moment another connection's append can commit between this transaction's
 * statements.
 */
function onFirstEventRead(tx: Tx, when: "before" | "after", hook: () => Promise<void>): Tx {
  let fired = false;
  const wrap = (builder: object): object =>
    new Proxy(builder, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (typeof value !== "function") return value;
        if (prop === "then") {
          return (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
            (async () => {
              const fire = !fired;
              fired = true;
              if (fire && when === "before") await hook();
              const rows = await new Promise((res, rej) => (value as AnyFn).call(target, res, rej));
              if (fire && when === "after") await hook();
              return rows;
            })().then(resolve, reject);
        }
        return (...args: unknown[]) => {
          const result = (value as AnyFn).apply(target, args);
          return result === target ? wrap(target) : result;
        };
      },
    });
  return new Proxy(tx, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== "function") return value;
      if (prop !== "select") return (value as AnyFn).bind(target);
      return (...args: unknown[]) => {
        const builder = (value as AnyFn).apply(target, args) as object;
        return new Proxy(builder, {
          get(b, p) {
            const v = Reflect.get(b, p, b) as unknown;
            if (typeof v !== "function") return v;
            if (p === "from") return (table: unknown, ...rest: unknown[]) => {
              const query = (v as AnyFn).call(b, table, ...rest) as object;
              return table === event ? wrap(query) : query;
            };
            return (v as AnyFn).bind(b);
          },
        });
      };
    },
  });
}

describe("verifyEngagementChain with concurrent appends", () => {
  it("stays ok when an append commits just before or just after the events are read", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    await createItem(e.ctx, { engagementId: e.engagementId, kind: "assumption", statement: "Carriers accept CSV uploads.", manual: true });
    const appendOne = (label: string) => async () => {
      // A second pool connection: commits while the verifying transaction is still open.
      await createItem(e.ctx, { engagementId: e.engagementId, kind: "decision", statement: `Appended ${label} the events read.`, manual: true });
    };

    for (const when of ["before", "after"] as const) {
      const headBefore = await withTenant(app.db, { orgId: e.orgId }, (tx) => readEngagementHead(tx, e.engagementId));
      const result = await withTenant(app.db, { orgId: e.orgId }, (tx) => verifyEngagementChain(onFirstEventRead(tx, when, appendOne(when)), e.engagementId));
      expect(result).toMatchObject({ ok: true });
      const headAfter = await withTenant(app.db, { orgId: e.orgId }, (tx) => readEngagementHead(tx, e.engagementId));
      expect(headAfter!.seq).toBe(headBefore!.seq + 1);
    }
  });

  it("control: reading the events first and the head afterwards reports the same interleaving as truncated", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    const result = await withTenant(app.db, { orgId: e.orgId }, async (tx) => {
      const rows = await readEvents(tx, e.engagementId);
      await createItem(e.ctx, { engagementId: e.engagementId, kind: "decision", statement: "Appended between the reads.", manual: true });
      const head = await readEngagementHead(tx, e.engagementId);
      return verifyChain(rows, head);
    });
    expect(result).toMatchObject({ ok: false, reason: "truncated" });
  });
});
