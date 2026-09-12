import { emptyAllocation } from "../src/memory-tree/allocation.js";
import { describe, expect, it } from "vitest";
import { ObserverProtocolError, ObserverStreamError, runObserver } from "../src/agents/observer/agent.js";
import { OBSERVER_SYSTEM } from "../src/agents/observer/prompts.js";
import { currentTreeText } from "../src/agents/observer/protocol.js";
import { MemoryTreeStore } from "../src/memory-tree/store.js";
import type { MemoryTree } from "../src/memory-tree/types.js";

function emptyTree(): MemoryTree {
	return { allocation: emptyAllocation(), observationsById: new Map(), segmentsById: new Map(), parentByChildId: new Map(), observationBatchesSinceSegmentation: 0, diagnostics: [] };
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
	it("exposes the Root short ID for editing even with visible direct children", () => {
		const tree = new MemoryTreeStore().rebuild([{ type: "custom", id: "memory", customType: "om.observations.recorded", data: {
			version: 2, highWater: { observation: "2", segment: "1" }, coversUpToId: "source", segmentCheck: "complete",
			nodeRecords: [{ id: "o1", content: "First fact.", sourceEntryIds: ["source"] }, { id: "o2", content: "Second fact.", sourceEntryIds: ["source"] },
				{ id: "s1", title: "Work", summary: "Done.", childIds: ["o1", "o2"] }],
		} }]);
		expect(currentTreeText(tree)).toContain("Root Segment: [s1]");
		expect(currentTreeText(tree)).toContain("- Observation [o1]");
		expect(currentTreeText(tree)).toContain("- Observation [o2]");
	});
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

	it("forwards the complete Observer system prompt", async () => {
		let systemPrompt = "";
		const loop = fakeAgentLoop(async (_prompts, context) => {
			systemPrompt = context.systemPrompt;
			await context.tools[0].execute("tool", { tree: null });
		});
		await runObserver({ ...args, agentLoop: loop });
		// This mock checks prompt delivery, not model comprehension. Semantic quality
		// belongs in the Observer eval so equivalent wording can evolve freely.
		expect(systemPrompt).toBe(OBSERVER_SYSTEM);
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
