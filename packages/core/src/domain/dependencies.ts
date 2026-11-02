/**
 * Dependency rules (ARCHITECTURE §3, D-024): dependents must be decisions or requirements; upstream
 * items can be of any kind except the item itself; cycles are rejected.
 */
import type { Kind } from "./events";
import type { EngagementState } from "./state";

const DEPENDENT_KINDS: ReadonlySet<Kind> = new Set<Kind>(["decision", "requirement"]);

/** Whether an item of this kind may depend on other items. */
export function canDependOn(dependentKind: Kind): boolean {
  return DEPENDENT_KINDS.has(dependentKind);
}

/**
 * True when adding the edge `itemId → dependsOnId` would create a cycle (including a self-edge),
 * i.e. when `itemId` is reachable from `dependsOnId` through existing `dependsOn` edges.
 */
export function wouldCreateCycle(state: EngagementState, itemId: string, dependsOnId: string): boolean {
  if (itemId === dependsOnId) return true;
  const seen = new Set<string>();
  const stack = [dependsOnId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === itemId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const item = state.items.get(current);
    if (item) for (const next of item.dependsOn.keys()) if (!seen.has(next)) stack.push(next);
  }
  return false;
}
