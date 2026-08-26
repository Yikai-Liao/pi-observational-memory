import { describe, expect, it } from "vitest";
import { ObserverProtocolError, ObserverStreamError, runObserver } from "../src/agents/observer/agent.js";
import type { MemoryTree } from "../src/memory-tree/types.js";

function emptyTree(): MemoryTree {
	return { observationsById: new Map(), segmentsById: new Map(), parentByChildId: new Map(), observationBatchesSinceSegmentation: 0, diagnostics: [] };
}

function fakeAgentLoop(handler: (prompts: any[], context: any, config: any) => Promise<void> | void, events: any[] = []): any {
	return ((prompts: any[], context: any, config: any) => ({
		async *[Symbol.asyncIterator]() { for (const event of events) yield event; },
		result: async () => { await handler(prompts, context, config); return {}; },
	})) as any;
}

const args = {
	model: {} as any,
	apiKey: "test",
	tree: emptyTree(),
	chunk: "[Source entry id: entry-a]\n[User]: Implement Segment Memory.",
	segmentRequired: false,
	successfulBatches: 0,
};

describe("runObserver", () => {
	it("submits exactly one recursive tree proposal", async () => {
		let config: any;
		const loop = fakeAgentLoop(async (_prompts, context, seenConfig) => {
			config = seenConfig;
			expect(config.shouldStopAfterTurn()).toBe(false);
			await context.tools[0].execute("tool", { tree: { type: "observation", content: "User requested Segment Memory implementation.", sourceEntryIds: ["entry-a"] } });
		});
		const result = await runObserver({ ...args, agentLoop: loop });
		expect(result.tree).toEqual({ type: "observation", content: "User requested Segment Memory implementation.", sourceEntryIds: ["entry-a"] });
		expect(config.shouldStopAfterTurn()).toBe(true);
	});

	it("uses the V3-style extraction rules plus Segment Tree constraints", async () => {
		let systemPrompt = "";
		const loop = fakeAgentLoop(async (_prompts, context) => {
			systemPrompt = context.systemPrompt;
			await context.tools[0].execute("tool", { tree: null });
		});
		await runObserver({ ...args, agentLoop: loop });
		expect(systemPrompt).toContain("Preserve exact user assertions");
		expect(systemPrompt).toContain("Frame state changes as supersession");
		expect(systemPrompt).toContain("Detail preservation");
		expect(systemPrompt).toContain("sourceEntryIds");
		expect(systemPrompt).toContain("at least two direct children");
		expect(systemPrompt).toContain("same id");
		expect(systemPrompt).toContain("Root identity and summary density");
		expect(systemPrompt).toContain("Hierarchy completion objective");
		expect(systemPrompt).toContain("Multi-level grouping example");
		expect(systemPrompt).not.toContain("relevance");
		expect(systemPrompt).not.toContain("dropper");
	});

	it("rejects missing and duplicate submissions", async () => {
		await expect(runObserver({ ...args, agentLoop: fakeAgentLoop(() => {}) })).rejects.toBeInstanceOf(ObserverProtocolError);
		const duplicate = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("first", { tree: null });
			await context.tools[0].execute("second", { tree: null });
		});
		await expect(runObserver({ ...args, agentLoop: duplicate })).rejects.toThrow(/more than once/);
	});

	it.each(["error", "aborted"])("surfaces terminal %s streams even after submission", async (stopReason) => {
		const loop = ((_prompts: any[], context: any) => ({
			async *[Symbol.asyncIterator]() {
				await context.tools[0].execute("tool", { tree: null });
				yield { message: { role: "assistant", stopReason, errorMessage: "stream stopped" } };
			},
			result: async () => ({}),
		})) as any;
		const promise = runObserver({ ...args, agentLoop: loop });
		await expect(promise).rejects.toBeInstanceOf(ObserverStreamError);
		await expect(promise).rejects.toMatchObject({ stopReason });
	});

	it("sends current tree, source, segmentation state, and batch count to the model", async () => {
		let prompt = "";
		const loop = fakeAgentLoop(async (prompts, context) => {
			prompt = prompts[0].content[0].text;
			await context.tools[0].execute("tool", { tree: null });
		});
		await runObserver({ ...args, segmentRequired: true, successfulBatches: 3, agentLoop: loop });
		expect(prompt).toContain("SEGMENT REQUIRED: yes");
		expect(prompt).toContain("Successful Observation batches since last completed segmentation: 3");
		expect(prompt).toContain("CURRENT TREE:\n(no Root yet)");
		expect(prompt).toContain(args.chunk);
	});

	it("forwards configured thinking without inventing a default", async () => {
		const seen: unknown[] = [];
		for (const thinkingLevel of [undefined, "minimal", "off"] as const) {
			const loop = fakeAgentLoop(async (_prompts, context, config) => {
				seen.push(config.reasoning);
				await context.tools[0].execute("tool", { tree: null });
			});
			await runObserver({ ...args, model: { reasoning: true } as any, thinkingLevel, agentLoop: loop });
		}
		expect(seen).toEqual([undefined, "minimal", undefined]);
	});
});
