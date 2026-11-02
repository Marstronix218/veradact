// Current engagement state = fold of the full log (D-006). Snapshots can be added here later
// without changing callers (ARCHITECTURE §15).
import type { Tx } from "@veradact/db";
import { fold, type EngagementState } from "../domain";
import { readEvents } from "./read-events";

export async function loadState(tx: Tx, engagementId: string): Promise<EngagementState> {
  return fold(await readEvents(tx, engagementId));
}
