import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "../../model-budget.js";
import type { MemoryTree, NodeProposal, ObserverOutput } from "../../memory-tree/types.js";
import { logAgentStreamError } from "../stream-errors.js";
import { OBSERVER_SYSTEM } from "./prompts.js";
import { buildObserverUserPrompt, OBSERVER_TOOL_SCHEMA } from "./protocol.js";

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

export async function runObserver(args: RunObserverArgs): Promise<ObserverOutput> {
	let submitted: ObserverOutput | undefined;
	let duplicateSubmission = false;
	const tool: AgentTool<any> = {
		name: "submit_memory_tree",
		label: "Submit memory tree",
		description: "Submit the single recursive Segment Memory Tree increment for this Observer run.",
		parameters: OBSERVER_TOOL_SCHEMA,
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

	const userText = buildObserverUserPrompt(args);
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
