import { getNode } from "./node.js";
import { inspectNode, type NodeRead, type SegmentRead } from "./inspect.js";
import { isObservation, type MemoryTree, type Node, type NodeId } from "./types.js";

export type ExportFormat = "markdown" | "json" | "jsonl";
export type SessionExportIdentity = { sessionId: string; name?: string; cwd?: string };

function markdown(node: NodeRead, heading = 1): string {
	if (node.kind === "observation") return `1. [${node.id}] ${node.content}`;
	const parts = [`${"#".repeat(heading)} [${node.id}] ${node.title}`];
	if (node.summary) parts.push(node.summary);
	const full = node.children.filter((child): child is NodeRead => !("preview" in child));
	const observations = full.filter((child) => child.kind === "observation");
	if (observations.length > 0) parts.push(observations.map((child, index) => `${index + 1}. [${child.id}] ${child.content}`).join("\n"));
	for (const child of full) if (child.kind === "segment") parts.push(markdown(child, heading + 1));
	if (full.length === 0 && node.children.length > 0) {
		parts.push((node.children as SegmentRead["children"]).map((child) => `- [${child.id}] ${"preview" in child ? child.preview : child.kind}`).join("\n"));
	}
	return parts.join("\n\n");
}

function jsonl(tree: MemoryTree, identity: SessionExportIdentity, nodeId: NodeId | undefined, depth: number, includeSummary: boolean): string {
	const root = nodeId ? getNode(tree, nodeId) : tree.root;
	if (!root) throw new Error("No Segment Memory has been recorded yet");
	const lines: unknown[] = [{ recordType: "session", sessionId: identity.sessionId, ...(identity.name ? { name: identity.name } : {}), ...(identity.cwd ? { cwd: identity.cwd } : {}) }];
	const walk = (node: Node, parentId: string | null, position: number, remaining: number): void => {
		lines.push(isObservation(node)
			? { recordType: "node", sessionId: identity.sessionId, nodeId: node.id, parentId, position, kind: "observation", content: node.content, sourceEntryIds: node.sourceEntryIds }
			: { recordType: "node", sessionId: identity.sessionId, nodeId: node.id, parentId, position, kind: "segment", title: node.title, ...(includeSummary ? { summary: node.summary } : {}) });
		if (isObservation(node) || remaining === 0) return;
		node.childIds.forEach((id, index) => walk(getNode(tree, id)!, node.id, index, remaining < 0 ? -1 : remaining - 1));
	};
	walk(root, null, 0, depth);
	return lines.map((line) => JSON.stringify(line)).join("\n");
}

export function exportMemory(
	tree: MemoryTree,
	identity: SessionExportIdentity,
	options: { nodeId?: NodeId; depth?: number; includeSummary?: boolean; format?: ExportFormat } = {},
): string {
	const depth = options.depth ?? 1;
	const includeSummary = options.includeSummary ?? true;
	const format = options.format ?? "markdown";
	if (format === "jsonl") return jsonl(tree, identity, options.nodeId, depth, includeSummary);
	const result = inspectNode(tree, options.nodeId, depth, includeSummary);
	return format === "json" ? JSON.stringify(result, null, 2) : markdown(result);
}
