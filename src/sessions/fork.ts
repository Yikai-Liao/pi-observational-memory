import { SessionManager } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { replayAllocation } from "../memory-tree/allocation.js";
import { OM_NODE_IDS_INHERITED, type Entry, type NodeHighWater, type NodeIdsInheritedData } from "../memory-tree/types.js";
import { hasInheritedIds, type MemorySession } from "./memory.js";

type Snapshot = { sourceSessionId: string; highWater: NodeHighWater };
type ForkSnapshots = { managers: WeakMap<object, Snapshot>; files: Map<string, Snapshot> };
const key = Symbol.for("pi-segment-memory.fork-snapshots.v1");
const globals = globalThis as typeof globalThis & { [key]?: ForkSnapshots };
const snapshots = globals[key] ??= { managers: new WeakMap(), files: new Map() };

export function captureForkIds(manager: MemorySession): void {
	const sourceSessionId = manager.getSessionId?.();
	if (!sourceSessionId) throw new Error("Cannot capture Fork IDs without a source Session ID");
	const snapshot = { sourceSessionId, highWater: replayAllocation(manager.getEntries() as Entry[]).highWater };
	snapshots.managers.set(manager, snapshot);
	const file = manager.getSessionFile?.();
	if (file) snapshots.files.set(file, snapshot);
}

/** Called inside the same queue as Observer, before this Session can allocate or expose IDs. */
export function initializeForkIds(
	manager: MemorySession,
	append: (customType: string, data: NodeIdsInheritedData) => void,
	event: { reason?: string; previousSessionFile?: string },
): void {
	const entries = manager.getEntries() as Entry[];
	const sessionId = manager.getSessionId?.();
	const parent = manager.getHeader?.()?.parentSession;
	if (hasInheritedIds(entries, sessionId)) return;
	if (event.reason !== "fork" && !parent) return;
	if (!sessionId) throw new Error("Cannot initialize Fork IDs without a Session ID");
	const sourceFile = parent ?? event.previousSessionFile;
	let snapshot = event.reason === "fork" ? snapshots.managers.get(manager) : undefined;
	if (snapshot?.sourceSessionId === sessionId) snapshot = undefined;
	if (!snapshot && sourceFile && event.reason === "fork") snapshot = snapshots.files.get(sourceFile);
	if (!snapshot && sourceFile) {
		if (!existsSync(sourceFile)) throw new Error("Cannot initialize Fork IDs: source ledger is unavailable");
		const source = SessionManager.open(sourceFile);
		snapshot = { sourceSessionId: source.getSessionId(), highWater: replayAllocation(source.getEntries() as Entry[]).highWater };
	}
	if (!snapshot) throw new Error("Cannot initialize Fork IDs: source allocation snapshot is unavailable");
	const data: NodeIdsInheritedData = { version: 1, sessionId, ...snapshot };
	// Validate monotonicity and schema against copied ancestry before the atomic metadata append.
	replayAllocation([...entries, { type: "custom", id: "fork-initialization", customType: OM_NODE_IDS_INHERITED, data }]);
	append(OM_NODE_IDS_INHERITED, data);
	snapshots.managers.delete(manager);
	if (sourceFile) snapshots.files.delete(sourceFile);
}
