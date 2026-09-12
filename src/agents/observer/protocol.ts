import { Type } from "@earendil-works/pi-ai";
import { isObservation, isSegment, type MemoryTree } from "../../memory-tree/types.js";

const NodeProposalSchema = Type.Union([
	Type.Object({ type: Type.Literal("ref"), id: Type.String({ pattern: "^[so][1-9][0-9]*$" }) }),
	Type.Object({
		type: Type.Literal("observation"),
		content: Type.String({ minLength: 1 }),
		sourceEntryIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
	}),
	Type.Object({
		type: Type.Literal("segment"),
		id: Type.Optional(Type.String({ pattern: "^s[1-9][0-9]*$" })),
		title: Type.String({ minLength: 1, maxLength: 120, description: "Short navigation label. Keep title plus summary strictly shorter than rendering direct children; for two short children use only a few words." }),
		summary: Type.String({ minLength: 1, maxLength: 2000, description: "Compact standalone handoff for this Segment. Nested phases preserve their concrete goal, chosen design, result, and blockers; ancestors keep only broader outcomes. Title plus summary MUST be strictly shorter than rendering direct children; this limit outranks detail, and for two children aim below half their combined content length." }),
		children: Type.Array(Type.Any(), { description: "Recursive NodeProposal children using the same ref/observation/segment shapes. Array order is ignored; code derives sibling order from descendant Observation sources." }),
	}),
]);

export const OBSERVER_TOOL_SCHEMA = Type.Object({ tree: Type.Union([NodeProposalSchema, Type.Null()]) });

export function currentTreeText(tree: MemoryTree): string {
	if (!tree.root) return "(no Root yet)";
	if (isObservation(tree.root)) {
		return `Root Observation: [${tree.root.id}] ${tree.root.content}\nSources: ${tree.root.sourceEntryIds.join(", ")}`;
	}
	const lines = [`Root Segment: [${tree.root.id}] ${tree.root.title}`, `Summary: ${tree.root.summary}`, "Direct children:"];
	for (const id of tree.root.childIds) {
		const child = tree.observationsById.get(id) ?? tree.segmentsById.get(id as `s${string}`);
		if (!child) continue;
		lines.push(isSegment(child)
			? `- Segment [${child.id}] ${child.title} — ${child.summary}`
			: `- Observation [${child.id}] ${child.content} (sources: ${child.sourceEntryIds.join(", ")})`);
	}
	return lines.join("\n");
}

export function buildObserverUserPrompt(args: {
	tree: MemoryTree;
	chunk: string;
	segmentRequired: boolean;
	successfulBatches: number;
}): string {
	return `SEGMENT REQUIRED: ${args.segmentRequired ? "yes" : "no"}
Successful Observation batches since last completed segmentation: ${args.successfulBatches}

CURRENT TREE:
${currentTreeText(args.tree)}

NEW SOURCE:
${args.chunk.trim() || "(none)"}`;
}
