/**
 * Pure property tests over random valid engagement logs (~1,000 events per property per run:
 * 30 cases × ~33 events). The DB rebuild == live test reuses the same arbitraries.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { verifyChain, type ChainRow } from "./chain";
import { isSourcedOrManual } from "./content-hash";
import { EVENT_TYPES } from "./events";
import { sha256Hex } from "./hash";
import { projectRows } from "./projection-rows";
import { fold, reduce } from "./reducer";
import { asOf } from "./replay";
import { currentVersionOf, type EngagementState } from "./state";
import { arbStoredLog, type ExpectedItem } from "./testing/arbitraries";

const RUNS = { numRuns: 30 };
const logs = arbStoredLog();

function expectMatchesOracle(state: EngagementState, exp: ReadonlyMap<string, ExpectedItem>) {
  expect(state.items.size).toBe(exp.size);
  for (const [id, e] of exp) {
    const item = state.items.get(id)!;
    expect({
      shortId: item.shortId,
      kind: item.kind,
      currentVersion: item.currentVersion,
      status: item.status,
      lifecycle: item.lifecycle,
      needsReview: item.needsReview,
      dependsOn: [...item.dependsOn.keys()].sort(),
    }).toEqual(e);
  }
}

/** Collects JSON paths to every leaf of a value. */
function leafPaths(value: unknown, path: (string | number)[] = [], out: (string | number)[][] = []): (string | number)[][] {
  if (Array.isArray(value)) value.forEach((v, i) => leafPaths(v, [...path, i], out));
  else if (value !== null && typeof value === "object") for (const k of Object.keys(value)) leafPaths((value as Record<string, unknown>)[k], [...path, k], out);
  else out.push(path);
  return out;
}

function mutateAt(root: unknown, path: (string | number)[]): void {
  let parent = root as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) parent = parent[key] as Record<string | number, unknown>;
  const key = path[path.length - 1]!;
  const v = parent[key];
  parent[key] = typeof v === "string" ? `${v}x` : typeof v === "number" ? v + 1 : typeof v === "boolean" ? !v : "was-null";
}

const FIELDS = ["payload", "type", "actorType", "actorId", "occurredAt", "recordedAt", "seq", "prevHash", "hash", "orgId", "engagementId", "schemaVersion"] as const;

function mutate(row: ChainRow, field: (typeof FIELDS)[number], pick: number): void {
  switch (field) {
    case "payload": {
      const paths = leafPaths(row.payload);
      mutateAt(row.payload, paths[pick % paths.length]!);
      break;
    }
    case "type": {
      const others = EVENT_TYPES.filter((t) => t !== row.type);
      row.type = others[pick % others.length]!;
      break;
    }
    case "actorType":
      row.actor = { ...row.actor, type: row.actor.type === "user" ? "system" : "user" };
      break;
    case "actorId":
      row.actor = { ...row.actor, id: row.actor.id === null ? "00000000-0000-4000-8000-000000000000" : null };
      break;
    case "occurredAt":
      row.occurredAt = new Date(row.occurredAt.getTime() + 1 + (pick % 1000));
      break;
    case "recordedAt":
      row.recordedAt = new Date(row.recordedAt.getTime() - 1 - (pick % 1000));
      break;
    case "seq":
      row.seq += 1 + (pick % 3);
      break;
    case "prevHash":
      row.prevHash = sha256Hex(`p${pick}`);
      break;
    case "hash":
      row.hash = sha256Hex(`h${pick}`);
      break;
    case "orgId":
      row.orgId = "00000000-0000-4000-8000-0000000000aa";
      break;
    case "engagementId":
      row.engagementId = "00000000-0000-4000-8000-0000000000bb";
      break;
    case "schemaVersion":
      row.schemaVersion += 1;
      break;
  }
}

describe("domain properties", () => {
  it("fold is deterministic and agrees with the generator's independent model", () => {
    fc.assert(
      fc.property(logs, (gen) => {
        const a = fold(gen.events);
        expect(fold(gen.events)).toEqual(a);
        expectMatchesOracle(a, gen.expected);
        expect(a.headSeq).toBe(gen.events.length);
        expect(a.headHash).toBe(gen.events[gen.events.length - 1]!.hash);
      }),
      RUNS,
    );
  });

  it("folding in one go equals folding incrementally from any split point", () => {
    fc.assert(
      fc.property(logs, fc.nat(), (gen, r) => {
        const k = r % (gen.events.length + 1);
        const prefix = fold(gen.events.slice(0, k));
        let state = prefix;
        for (const e of gen.events.slice(k)) state = reduce(state, e);
        expect(state).toEqual(fold(gen.events));
        expect(fold(gen.events.slice(k), prefix)).toEqual(state);
      }),
      RUNS,
    );
  });

  it("reduce never mutates its input state", () => {
    fc.assert(
      fc.property(logs, fc.nat(), (gen, r) => {
        const k = r % gen.events.length;
        const before = fold(gen.events.slice(0, k));
        const snapshot = structuredClone(before);
        reduce(before, gen.events[k]!);
        expect(before).toEqual(snapshot);
      }),
      RUNS,
    );
  });

  it("asOf(last recordedAt, 'known') equals fold(all); asOf(T) equals the fold of events recorded by T", () => {
    fc.assert(
      fc.property(logs, fc.nat(), (gen, r) => {
        const last = gen.events[gen.events.length - 1]!.recordedAt;
        expect(asOf(gen.events, last, "known").state).toEqual(fold(gen.events));
        const t = gen.events[r % gen.events.length]!.recordedAt;
        const expected = fold(gen.events.filter((e) => e.recordedAt.getTime() <= t.getTime()));
        expect(asOf(gen.events, t, "known").state).toEqual(expected);
      }),
      RUNS,
    );
  });

  it("agreed view partitions active items consistently", () => {
    fc.assert(
      fc.property(logs, (gen) => {
        const t = gen.events[gen.events.length - 1]!.recordedAt;
        const state = fold(gen.events);
        const view = asOf(gen.events, t, "agreed");
        const active = [...state.items.values()].filter((i) => i.lifecycle === "active");
        expect(new Set(view.items.map((i) => i.itemId))).toEqual(new Set(active.filter((i) => i.status === "confirmed").map((i) => i.id)));
        expect(new Set(view.notConfirmed.map((i) => i.itemId))).toEqual(new Set(active.filter((i) => i.status !== "confirmed").map((i) => i.id)));
        for (const p of view.previouslyAgreed) {
          expect(view.notConfirmed.find((n) => n.itemId === p.itemId)?.revisionPending).toBe(true);
          expect(p.agreedVersion).toBeLessThan(p.currentVersion);
          expect(p.confirmations.length).toBeGreaterThan(0);
        }
        for (const a of view.items) {
          expect(a.confirmations.length).toBeGreaterThan(0);
          expect(a.version).toBe(state.items.get(a.itemId)!.currentVersion);
        }
      }),
      RUNS,
    );
  });

  it("projectRows(fold(events)) is stable under re-folding", () => {
    fc.assert(
      fc.property(logs, (gen) => {
        const rows = projectRows(fold(gen.events));
        expect(projectRows(fold(gen.events))).toEqual(rows);
        expect(projectRows(fold(structuredClone(gen.events)))).toEqual(rows);
        expect(rows.item.length).toBe(gen.expected.size);
        expect(rows.item_version.length).toBe([...fold(gen.events).items.values()].reduce((n, i) => n + i.versions.length, 0));
      }),
      RUNS,
    );
  });

  it("verifyChain passes on generated chains and fails after any single mutation", () => {
    fc.assert(
      fc.property(logs, fc.nat(), fc.constantFrom(...FIELDS), fc.nat(), (gen, r, field, pick) => {
        expect(verifyChain(gen.events, { seq: gen.events.length, hash: gen.events[gen.events.length - 1]!.hash }).ok).toBe(true);
        const rows: ChainRow[] = structuredClone(gen.events);
        const i = r % rows.length;
        mutate(rows[i]!, field, pick);
        const result = verifyChain(rows);
        expect(result.ok).toBe(false);
        expect(result.firstBadSeq).toBeLessThanOrEqual(i + 1);
      }),
      { numRuns: 60 },
    );
  });

  it("a strict prefix of a log is truncated relative to the full head", () => {
    fc.assert(
      fc.property(logs, fc.nat(), (gen, r) => {
        const head = { seq: gen.events.length, hash: gen.events[gen.events.length - 1]!.hash };
        const k = r % gen.events.length;
        expect(verifyChain(gen.events.slice(0, k), head)).toMatchObject({ ok: false, reason: "truncated", firstBadSeq: k + 1 });
      }),
      RUNS,
    );
  });

  it("every item version is sourced or manual", () => {
    fc.assert(
      fc.property(logs, (gen) => {
        for (const item of fold(gen.events).items.values()) {
          for (const v of item.versions) expect(isSourcedOrManual(v.spans, v.manual)).toBe(true);
        }
      }),
      RUNS,
    );
  });

  it("status is never confirmed (or disputed) without a matching response on the current version's content hash", () => {
    fc.assert(
      fc.property(logs, fc.nat(), (gen, r) => {
        const k = 1 + (r % gen.events.length);
        for (const item of fold(gen.events.slice(0, k)).items.values()) {
          const cur = currentVersionOf(item);
          const onCurrent = item.responses.filter((x) => x.version === cur.version && x.contentHash === cur.contentHash);
          if (item.status === "confirmed") expect(onCurrent.some((x) => x.response === "confirmed")).toBe(true);
          if (item.status === "disputed") expect(onCurrent.some((x) => x.response === "disputed")).toBe(true);
          if (onCurrent.length === 0) expect(item.status).toBe("pending");
        }
      }),
      RUNS,
    );
  });
});
