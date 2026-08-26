import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "../../model-budget.js";
import { isObservation, isSegment, type MemoryTree, type NodeProposal, type ObserverOutput } from "../../memory-tree/types.js";
import { logAgentStreamError } from "../stream-errors.js";
import { OBSERVER_SYSTEM } from "./prompts.js";

export interface RunObserverArgs {
	model: Model<any>;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	baseUrl?: string;
	tree: MemoryTree;
	chunk: string;
	segmentRequired: boolean;
	successfulBatches: number;
	signal?: AbortSignal;
	agentLoop?: typeof agentLoop;
	thinkingLevel?: ModelThinkingLevel;
}

const NodeProposalSchema = Type.Union([
	Type.Object({ type: Type.Literal("ref"), id: Type.String({ minLength: 1 }) }),
	Type.Object({
		type: Type.Literal("observation"),
		content: Type.String({ minLength: 1 }),
		sourceEntryIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
	}),
	Type.Object({
		type: Type.Literal("segment"),
		id: Type.Optional(Type.String({ pattern: "^s_[a-f0-9]{12}$" })),
		title: Type.String({ minLength: 1, maxLength: 120 }),
		summary: Type.String({ minLength: 1, maxLength: 2000 }),
		children: Type.Array(Type.Any(), { description: "Recursive NodeProposal children using the same ref/observation/segment shapes." }),
	}),
]);

const SubmitTreeSchema = Type.Object({ tree: Type.Union([NodeProposalSchema, Type.Null()]) });

export class ObserverStreamError extends Error {
	constructor(readonly stopReason: string, errorMessage?: string) {
		super(`observer stream ended with stopReason "${stopReason}"${errorMessage ? `: ${errorMessage}` : ""}`);
		this.name = "ObserverStreamError";
	}
}

export class ObserverProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ObserverProtocolError";
	}
}

function currentTreeText(tree: MemoryTree): string {
	if (!tree.root) return "(no Root yet)";
	if (isObservation(tree.root)) {
		return `Root Observation: [${tree.root.id}] ${tree.root.content}\nSources: ${tree.root.sourceEntryIds.join(", ")}`;
	}
	const lines = [`Root Segment: [${tree.root.id}] ${tree.root.title}`, `Summary: ${tree.root.summary}`, "Direct children:"];
	for (const id of tree.root.childIds) {
		const child = tree.observationsById.get(id) ?? tree.segmentsById.get(id as `s_${string}`);
		if (!child) continue;
		lines.push(isSegment(child)
			? `- Segment [${child.id}] ${child.title} — ${child.summary}`
			: `- Observation [${child.id}] ${child.content} (sources: ${child.sourceEntryIds.join(", ")})`);
	}
	return lines.join("\n");
}

export async function runObserver(args: RunObserverArgs): Promise<ObserverOutput> {
	let submitted: ObserverOutput | undefined;
	let duplicateSubmission = false;
	const tool: AgentTool<any> = {
		name: "submit_memory_tree",
		label: "Submit memory tree",
		description: "Submit the single recursive Segment Memory Tree increment for this Observer run.",
		parameters: SubmitTreeSchema,
		execute: async (_id, params) => {
			const typed = params as { tree: NodeProposal | null };
			if (submitted) {
				duplicateSubmission = true;
				return { content: [{ type: "text", text: "Rejected: submit_memory_tree may be called only once." }], details: { accepted: false } };
			}
			submitted = { tree: typed.tree };
			return { content: [{ type: "text", text: "Accepted." }], details: { accepted: true } };
		},
	};

	const userText = `SEGMENT REQUIRED: ${args.segmentRequired ? "yes" : "no"}
Successful Observation batches since last completed segmentation: ${args.successfulBatches}

CURRENT TREE:
${currentTreeText(args.tree)}

NEW SOURCE:
${args.chunk.trim() || "(none)"}`;
	const prompts: Message[] = [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }];
	const context: AgentContext = { systemPrompt: OBSERVER_SYSTEM, messages: [], tools: [tool] };
	const config: AgentLoopConfig = {
		model: args.model,
		apiKey: args.apiKey,
		headers: args.headers,
		env: args.env,
		maxTokens: boundedMaxTokens(args.model, AGENT_LOOP_MAX_TOKENS),
		convertToLlm: (messages) => messages as Message[],
		toolExecution: "sequential",
		shouldStopAfterTurn: () => submitted !== undefined,
		...((args.model as { reasoning?: unknown }).reasoning && args.thinkingLevel && args.thinkingLevel !== "off"
			? { reasoning: args.thinkingLevel as Exclude<ModelThinkingLevel, "off"> }
			: {}),
	};

	let streamError: { stopReason: string; errorMessage?: string } | undefined;
	const stream = (args.agentLoop ?? agentLoop)(prompts, context, config, args.signal, streamSimple);
	for await (const event of stream) {
		logAgentStreamError("observer", event);
		const message = (event as { message?: { role?: string; stopReason?: string; errorMessage?: string } }).message;
		if (message?.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) {
			streamError = { stopReason: message.stopReason, errorMessage: message.errorMessage };
		}
	}
	await stream.result();
	if (streamError) throw new ObserverStreamError(streamError.stopReason, streamError.errorMessage);
	if (duplicateSubmission) throw new ObserverProtocolError("observer called submit_memory_tree more than once");
	if (!submitted) throw new ObserverProtocolError("observer ended without calling submit_memory_tree");
	return submitted;
}
