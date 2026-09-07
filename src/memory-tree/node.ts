import { isSegment, type MemoryTree, type Node, type NodeId, type Segment } from "./types.js";

export const MAX_SEGMENT_TITLE_CHARS = 120;
export const MAX_SEGMENT_SUMMARY_CHARS = 2_000;

export function getNode(tree: MemoryTree, id: NodeId): Node | undefined {
	return tree.observationsById.get(id) ?? tree.segmentsById.get(id as Segment["id"]);
}

export function nodeChildren(tree: MemoryTree, node: Node): Node[] {
	if (!isSegment(node)) return [];
	return node.childIds.map((id) => getNode(tree, id)).filter((child): child is Node => child !== undefined);
}

export function nodePreview(node: Node): string {
	return isSegment(node) ? `${node.title}: ${node.summary}` : node.content;
}

export function validObservationContent(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && !/[\r\n]/.test(value);
}

export function validSegmentTitle(value: unknown): value is string {
	return typeof value === "string"
		&& value.trim().length > 0
		&& value.length <= MAX_SEGMENT_TITLE_CHARS
		&& !/[\r\n]/.test(value);
}

export function validSegmentSummary(value: unknown): value is string {
	return typeof value === "string"
		&& value.trim().length > 0
		&& value.length <= MAX_SEGMENT_SUMMARY_CHARS
		&& !/[\r\n]/.test(value);
}
