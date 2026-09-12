import { MemoryTreeStore } from "../memory-tree/store.js";
import { isNodeIdsInheritedData, OM_NODE_IDS_INHERITED, type Entry } from "../memory-tree/types.js";
import { assertSessionReadable } from "./writer.js";

export type MemorySession = {
	getBranch: () => unknown;
	getEntries: () => unknown;
	getSessionId?: () => string;
	getSessionFile?: () => string | undefined;
	getHeader?: () => { parentSession?: string } | null;
};

export function hasInheritedIds(entries: Entry[], sessionId: string | undefined): boolean {
	return entries.some((entry) => entry.type === "custom" && entry.customType === OM_NODE_IDS_INHERITED
		&& isNodeIdsInheritedData(entry.data) && entry.data.sessionId === sessionId);
}

export function readSessionMemory(manager: MemorySession) {
	assertSessionReadable(manager);
	const allEntries = manager.getEntries() as Entry[];
	if (manager.getHeader?.()?.parentSession && !hasInheritedIds(allEntries, manager.getSessionId?.())) {
		throw new Error("Fork node IDs are not initialized; activate this Session before reading its memory");
	}
	return new MemoryTreeStore().rebuild(manager.getBranch() as Entry[], allEntries);
}
