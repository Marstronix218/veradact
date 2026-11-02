import { describe, expect, it } from "vitest";
import { canDependOn, wouldCreateCycle } from "./dependencies";
import { KINDS } from "./events";
import { fold } from "./reducer";
import { LogBuilder } from "./testing/log-builder";

describe("canDependOn", () => {
  it("allows only decisions and requirements as dependents", () => {
    expect(KINDS.filter(canDependOn)).toEqual(["decision", "requirement"]);
  });
});

describe("wouldCreateCycle", () => {
  const b = new LogBuilder()
    .engagement()
    .create("c1", "constraint", "C")
    .create("r1", "requirement", "R1", { dependsOn: ["c1"] })
    .create("r2", "requirement", "R2", { dependsOn: ["r1"] })
    .create("d1", "decision", "D", { dependsOn: ["r2"] })
    .create("d2", "decision", "D2");
  const state = fold(b.log);
  const id = (n: string) => b.item(n).id;

  it("rejects self-edges", () => {
    expect(wouldCreateCycle(state, id("r1"), id("r1"))).toBe(true);
  });

  it("rejects direct and transitive cycles", () => {
    expect(wouldCreateCycle(state, id("r1"), id("r2"))).toBe(true);
    expect(wouldCreateCycle(state, id("r1"), id("d1"))).toBe(true);
    expect(wouldCreateCycle(state, id("c1"), id("d1"))).toBe(true);
  });

  it("allows acyclic edges, including diamonds and unknown upstream ids", () => {
    expect(wouldCreateCycle(state, id("d1"), id("c1"))).toBe(false);
    expect(wouldCreateCycle(state, id("d1"), id("r1"))).toBe(false);
    expect(wouldCreateCycle(state, id("d2"), id("d1"))).toBe(false);
    expect(wouldCreateCycle(state, id("d2"), b.id("item:unknown"))).toBe(false);
  });

  it("sees edges removed by dependency_removed", () => {
    const after = fold(b.removeDep("r2", "r1").log);
    expect(wouldCreateCycle(after, id("r1"), id("d1"))).toBe(false);
  });
});
