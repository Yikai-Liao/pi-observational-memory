import { MemoryTreeError } from "./error.js";
import {
	isNodeId, isNodeIdsInheritedData, isObservationsRecordedData, isObservation,
	OM_NODE_IDS_INHERITED, OM_OBSERVATIONS_RECORDED,
	type Entry, type Node, type NodeAllocation, type NodeHighWater, type ObservationsRecordedEntryData,
} from "./types.js";

export function emptyAllocation(): NodeAllocation {
	return { highWater: { segment: "0", observation: "0" }, birthEntryById: new Map() };
}

export function nodeSequence(id: string): { kind: keyof NodeHighWater; number: bigint } {
	if (!isNodeId(id)) throw new MemoryTreeError(`invalid memory node ID ${id}; expected sN or oN`);
	return { kind: id[0] === "s" ? "segment" : "observation", number: BigInt(id.slice(1)) };
}

function checkWater(previous: NodeHighWater, next: NodeHighWater): void {
	for (const kind of ["segment", "observation"] as const) {
		if (BigInt(next[kind]) < BigInt(previous[kind])) throw new MemoryTreeError(`${kind} ID high-water mark decreased`);
	}
}

/** Validate the entire commit before returning a new projection. Never mutate the caller's state. */
export function applyAllocation(state: NodeAllocation, data: ObservationsRecordedEntryData, entryId: string): NodeAllocation {
	if (!isObservationsRecordedData(data)) throw new MemoryTreeError(`malformed ${OM_OBSERVATIONS_RECORDED} entry ${entryId}`);
	checkWater(state.highWater, data.highWater);
	const births = new Map(state.birthEntryById);
	const seen = new Set<string>();
	for (const node of data.nodeRecords) {
		if (seen.has(node.id)) throw new MemoryTreeError(`entry ${entryId} repeats node record ${node.id}`);
		seen.add(node.id);
		const { kind, number } = nodeSequence(node.id);
		if (number > BigInt(data.highWater[kind])) throw new MemoryTreeError(`node ${node.id} exceeds its high-water mark`);
		if (births.has(node.id)) {
			if (isObservation(node)) throw new MemoryTreeError(`observation ${node.id} cannot be updated`);
		} else {
			if (number <= BigInt(state.highWater[kind])) throw new MemoryTreeError(`node ${node.id} reuses an occupied ID`);
			births.set(node.id, entryId);
		}
	}
	return { highWater: { ...data.highWater }, birthEntryById: births };
}

export function highWaterAfter(state: NodeAllocation, records: Node[]): NodeHighWater {
	const water = { ...state.highWater };
	for (const node of records) {
		const { kind, number } = nodeSequence(node.id);
		if (number > BigInt(water[kind])) water[kind] = number.toString();
	}
	return water;
}

/** Whole-session projection only: never merge different branches into one memory tree. */
export function replayAllocation(entries: Entry[]): NodeAllocation {
	let state = emptyAllocation();
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const initializedSessions = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType === OM_NODE_IDS_INHERITED) {
			if (!isNodeIdsInheritedData(entry.data)) throw new MemoryTreeError(`malformed ${OM_NODE_IDS_INHERITED} entry ${entry.id}`);
			if (initializedSessions.has(entry.data.sessionId)) throw new MemoryTreeError(`repeated Fork initialization for ${entry.data.sessionId}`);
			checkWater(state.highWater, entry.data.highWater);
			state = { ...state, highWater: { ...entry.data.highWater } };
			initializedSessions.add(entry.data.sessionId);
		} else if (entry.customType === OM_OBSERVATIONS_RECORDED) {
			if (!isObservationsRecordedData(entry.data)) throw new MemoryTreeError(`malformed ${OM_OBSERVATIONS_RECORDED} entry ${entry.id}`);
			// Pi entries have parentId. In-memory callers may supply a flat ledger without links.
			if (entry.parentId !== undefined) {
				const ancestors = new Set<string>();
				let parent = entry.parentId;
				while (parent) {
					if (ancestors.has(parent)) throw new MemoryTreeError("cycle in Session ledger ancestry");
					ancestors.add(parent);
					parent = byId.get(parent)?.parentId ?? null;
				}
				for (const node of entry.data.nodeRecords) {
					const birth = state.birthEntryById.get(node.id);
					if (birth && !ancestors.has(birth)) throw new MemoryTreeError(`node ${node.id} belongs to another branch`);
				}
			}
			state = applyAllocation(state, entry.data, entry.id);
		}
	}
	return state;
}
