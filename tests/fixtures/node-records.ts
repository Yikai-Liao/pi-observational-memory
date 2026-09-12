import type { NodeAllocation } from "../../src/memory-tree/types.js";

/** Concise valid envelopes for tree-shape tests. Allocation tests use explicit ledger values. */
export function recorded<T extends { nodeRecords: any[] }>(data: T) {
	const highWater = { segment: "0", observation: "0" };
	for (const node of data.nodeRecords) {
		for (const id of [node.id, ...(node.childIds ?? [])]) {
			if (typeof id !== "string" || !/^[so][1-9][0-9]*$/.test(id)) continue;
			const kind = id[0] === "s" ? "segment" : "observation";
			if (BigInt(id.slice(1)) > BigInt(highWater[kind])) highWater[kind] = id.slice(1);
		}
	}
	return { ...data, version: 2 as const, highWater };
}

export function allocationFor(nodes: Array<{ id: string }>): NodeAllocation {
	return { highWater: recorded({ version: 2, nodeRecords: nodes }).highWater, birthEntryById: new Map(nodes.map((node) => [node.id, "fixture"])) };
}
