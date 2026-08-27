import { estimateStringTokens } from "../tokens.js";
import { getNode } from "./node.js";
import { isObservation, isSegment, SEGMENT_RENDERED_DETAILS, type MemoryTree, type Node, type NodeId, type Observation, type SegmentMemoryDetails } from "./types.js";

const INTRO = `These are your past working memories, organized as a Segment Tree.

- Headings are Segments, and each \`[ID]\` is a node ID.
- Numbered items are leaf Observations.
- Older memories may retain only high-level summaries. Use \`om_read\` with a node ID to expand and review them if you need.`;

export type RenderedMemory = {
	markdown: string;
	nodes: Node[];
	estimatedTokens: number;
	details: SegmentMemoryDetails;
};

function visit(tree: MemoryTree, node: Node, depth: number, memoryDepth: number, nodes: Node[], sections: string[]): void {
	nodes.push(node);
	if (isObservation(node)) {
		sections.push(`# Memory\n\n1. [${node.id}] ${node.content}`);
		return;
	}

	sections.push(`${"#".repeat(depth + 1)} [${node.id}] ${node.title}\n\n${node.summary}`);
	if (depth >= memoryDepth) return;

	const children = node.childIds.map((id) => getNode(tree, id)).filter((child): child is Node => child !== undefined);
	let observationIndex = 0;
	let observations: Observation[] = [];
	const flushObservations = () => {
		if (observations.length === 0) return;
		nodes.push(...observations);
		sections.push(observations.map((observation) => `${++observationIndex}. [${observation.id}] ${observation.content}`).join("\n"));
		observations = [];
	};
	for (const child of children) {
		if (isObservation(child)) observations.push(child);
		else {
			flushObservations();
			visit(tree, child, depth + 1, memoryDepth, nodes, sections);
		}
	}
	flushObservations();
}

export function renderMemoryTree(tree: MemoryTree, memoryDepth: number): RenderedMemory {
	if (!Number.isInteger(memoryDepth) || memoryDepth < 0) throw new Error("memoryDepth must be a non-negative integer");
	const nodes: Node[] = [];
	const sections: string[] = [];
	if (tree.root) visit(tree, tree.root, 0, memoryDepth, nodes, sections);
	const markdown = sections.length > 0 ? `${INTRO}\n\n${sections.join("\n\n")}` : "";
	return {
		markdown,
		nodes,
		estimatedTokens: estimateStringTokens(markdown),
		details: {
			type: SEGMENT_RENDERED_DETAILS,
			version: 1,
			memoryDepth,
			renderedNodeIds: nodes.map((node) => node.id as NodeId),
		},
	};
}

export function maxTreeDepth(tree: MemoryTree): number {
	const depth = (node: Node, current: number): number => {
		if (isObservation(node)) return current;
		return node.childIds.reduce((max, id) => {
			const child = getNode(tree, id);
			return child ? Math.max(max, depth(child, current + 1)) : max;
		}, current);
	};
	return tree.root ? depth(tree.root, 0) : 0;
}
