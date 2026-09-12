import { getNode } from "./node.js";
import { isNodeId, isObservation, type MemoryTree, type Node, type NodeId } from "./types.js";

export type ObservationRead = {
	kind: "observation";
	id: string;
	content: string;
	sourceEntryIds: string[];
};

export type SegmentRead = {
	kind: "segment";
	id: string;
	title: string;
	summary?: string;
	children: Array<ObservationRead | SegmentRead | { kind: "observation" | "segment"; id: string; preview: string }>;
};

export type NodeRead = ObservationRead | SegmentRead;

function read(tree: MemoryTree, node: Node, depth: number, includeSummary: boolean): NodeRead {
	if (isObservation(node)) return { kind: "observation", id: node.id, content: node.content, sourceEntryIds: node.sourceEntryIds };
	return {
		kind: "segment",
		id: node.id,
		title: node.title,
		...(includeSummary ? { summary: node.summary } : {}),
		children: node.childIds.map((id) => {
			const child = getNode(tree, id)!;
			if (depth === 0) return {
				kind: isObservation(child) ? "observation" as const : "segment" as const,
				id: child.id,
				preview: isObservation(child) ? child.content : child.title,
			};
			return read(tree, child, depth < 0 ? -1 : depth - 1, includeSummary);
		}),
	};
}

export function inspectNode(tree: MemoryTree, nodeId?: NodeId, depth = 1, includeSummary = true): NodeRead {
	if (!Number.isInteger(depth) || depth < -1) throw new Error("depth must be -1 or a non-negative integer");
	if (nodeId !== undefined && !isNodeId(nodeId)) throw new Error(`Invalid node ID ${nodeId}; expected an exact sN or oN reference`);
	const node = nodeId ? getNode(tree, nodeId) : tree.root;
	if (!node) {
		if (nodeId && tree.allocation.birthEntryById.has(nodeId)) throw new Error(`Memory node ${nodeId} does not belong to the current branch`);
		throw new Error(nodeId ? `Unknown memory node reference ${nodeId}` : "No Segment Memory has been recorded yet");
	}
	return read(tree, node, depth, includeSummary);
}
