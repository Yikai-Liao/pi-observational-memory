import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../src/config.js";
import { registerConsolidationTrigger, runObserverOnce } from "../src/hooks/consolidation-trigger.js";
import { MemoryTreeStore } from "../src/memory-tree/store.js";
import { OM_OBSERVATIONS_RECORDED, type Entry } from "../src/memory-tree/types.js";
import { Runtime } from "../src/runtime.js";

const { runObserver } = vi.hoisted(() => ({ runObserver: vi.fn() }));
vi.mock("../src/agents/observer/agent.js", () => ({ runObserver: (...args: unknown[]) => runObserver(...args) }));

function setup(initial: Entry[] = []) {
	let entries = [...initial];
	const appended: Array<{ customType: string; data: any }> = [];
	const handlers = new Map<string, (event: unknown, ctx: any) => unknown>();
	const pi = {
		appendEntry(customType: string, data: any) {
			appended.push({ customType, data });
			entries.push({ type: "custom", id: `event-${appended.length}`, customType, data });
		},
		on(event: string, handler: (event: unknown, ctx: any) => unknown) {
			handlers.set(event, handler);
		},
	} as any;
	const ctx = {
		cwd: "/project",
		hasUI: false,
		model: { provider: "test", id: "model", contextWindow: 100_000 },
		modelRegistry: { getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "key" })), isUsingOAuth: vi.fn(() => false) },
		sessionManager: { getSessionId: () => "session-a", getBranch: () => entries },
	};
	const runtime = new Runtime();
	runtime.config = { ...DEFAULTS, segmentEveryObserverRuns: 2 };
	runtime.configLoaded = true;
	runtime.beginSession("session-a");
	return {
		pi,
		ctx,
		runtime,
		appended,
		entries: () => entries,
		setEntries: (value: Entry[]) => { entries = value; },
		emit: (event: string) => handlers.get(event)?.({}, ctx),
	};
}

const raw = (id: string, text: string): Entry => ({ type: "message", id, message: { role: "user", content: [{ type: "text", text }] } });

describe("single Observer pipeline", () => {
	beforeEach(() => runObserver.mockReset());

	it("wires session lifecycle events to Runtime invalidation and shutdown", () => {
		const state = setup();
		registerConsolidationTrigger(state.pi, state.runtime);
		state.emit("session_start");
		expect(state.runtime.sessionId).toBe("session-a");
		const beforeTree = state.runtime.branchGeneration;
		const signal = state.runtime.sessionAbort.signal;
		state.emit("session_tree");
		expect(state.runtime.branchGeneration).toBe(beforeTree + 1);
		expect(signal.aborted).toBe(true);
		state.emit("session_shutdown");
		expect(state.runtime.sessionId).toBeUndefined();
		expect(state.runtime.sessionAbort.signal.aborted).toBe(true);
	});

	it("writes at most one recursive event and segments on the configured successful batch", async () => {
		const state = setup([raw("raw-1", "Choose Segment Memory.")]);
		runObserver.mockImplementationOnce(async () => ({ tree: { type: "observation", content: "User chose Segment Memory as the architecture.", sourceEntryIds: ["raw-1"] } }));
		await runObserverOnce(state.pi, state.runtime, state.ctx, { forced: false });
		expect(state.appended).toHaveLength(1);
		expect(state.appended[0]?.customType).toBe(OM_OBSERVATIONS_RECORDED);
		expect(state.appended[0]?.data.segmentCheck).toBe("not_requested");
		const firstTree = new MemoryTreeStore().rebuild(state.entries());
		expect(firstTree.observationBatchesSinceSegmentation).toBe(1);
		const firstId = firstTree.root!.id;

		state.setEntries([...state.entries(), raw("raw-2", "Implement the tree now.")]);
		runObserver.mockImplementationOnce(async ({ tree, segmentRequired }) => {
			expect(segmentRequired).toBe(true);
			return { tree: {
				type: "segment",
				title: "Segment Memory implementation",
				summary: "Selected and started the Segment Memory implementation.",
				children: [
					{ type: "ref", id: tree.root.id },
					{ type: "observation", content: "User requested implementation of the selected Segment Memory architecture.", sourceEntryIds: ["raw-2"] },
				],
			} };
		});
		await runObserverOnce(state.pi, state.runtime, state.ctx, { forced: false });
		expect(state.appended).toHaveLength(2);
		const tree = new MemoryTreeStore().rebuild(state.entries());
		expect(tree.root?.id).toMatch(/^s_[a-f0-9]{12}$/);
		expect((tree.root as any).childIds).toContain(firstId);
		expect(tree.observationBatchesSinceSegmentation).toBe(0);
		expect(runObserver).toHaveBeenCalledTimes(2);
	});

	it("forces Observer for an existing Root even when there is no pending source", async () => {
		const a = { id: "aaaaaaaaaaaa", content: "A durable architecture observation with enough detail to persist.", sourceEntryIds: ["raw-a"] };
		const b = { id: "bbbbbbbbbbbb", content: "A second durable implementation observation with enough detail to persist.", sourceEntryIds: ["raw-b"] };
		const root = { id: "s_111111111111" as const, title: "Completed work", summary: "Summarized completed work.", childIds: [a.id, b.id] };
		const memory: Entry = { type: "custom", id: "memory", customType: OM_OBSERVATIONS_RECORDED, data: { version: 1, nodeRecords: [a, b, root], coversUpToId: "raw-b", segmentCheck: "complete" } };
		const state = setup([raw("raw-a", "a"), raw("raw-b", "b"), memory]);
		runObserver.mockImplementationOnce(async ({ segmentRequired, chunk }) => {
			expect(segmentRequired).toBe(true);
			expect(chunk).toBe("");
			return { tree: null };
		});
		await runObserverOnce(state.pi, state.runtime, state.ctx, { forced: true });
		expect(runObserver).toHaveBeenCalledTimes(1);
		expect(state.appended[0]?.data.segmentCheck).toBe("complete");
	});

	it("forced runs ignore the background chunk cap and complete segmentation with no new Observation", async () => {
		const a = { id: "aaaaaaaaaaaa", content: "A long durable observation describing completed architecture work and its important result.", sourceEntryIds: ["raw-a"] };
		const b = { id: "bbbbbbbbbbbb", content: "A second durable observation describing implementation work and its verified result.", sourceEntryIds: ["raw-b"] };
		const root = { id: "s_111111111111" as const, title: "Completed work", summary: "Summarized completed work.", childIds: [a.id, b.id] };
		const memory: Entry = { type: "custom", id: "memory", customType: OM_OBSERVATIONS_RECORDED, data: { version: 1, nodeRecords: [a, b, root], coversUpToId: "raw-b", segmentCheck: "complete" } };
		const huge = `HEAD-${"x".repeat(2500)}-MIDDLE-MARKER-${"x".repeat(2500)}-TAIL`;
		const state = setup([raw("raw-a", "a"), raw("raw-b", "b"), memory, raw("raw-c", huge)]);
		state.runtime.config = { ...state.runtime.config, observerChunkMaxTokens: 256 };
		runObserver.mockImplementationOnce(async ({ tree, chunk, segmentRequired }) => {
			expect(chunk).toContain("MIDDLE-MARKER");
			expect(chunk).not.toContain("middle omitted");
			expect(segmentRequired).toBe(true);
			return { tree: { type: "segment", id: tree.root.id, title: tree.root.title, summary: tree.root.summary, children: tree.root.childIds.map((id: string) => ({ type: "ref", id })) } };
		});
		await runObserverOnce(state.pi, state.runtime, state.ctx, { forced: true });
		expect(state.appended[0]?.data.segmentCheck).toBe("complete");
		expect(state.appended[0]?.data.coversUpToId).toBeUndefined();
	});

	it("backs off after an empty run until another threshold of source arrives, but not during forced compaction", async () => {
		const state = setup([raw("raw-1", "x".repeat(1000))]);
		state.runtime.config = { ...state.runtime.config, observeAfterTokens: 10 };
		registerConsolidationTrigger(state.pi, state.runtime);
		runObserver.mockResolvedValue({ tree: null });

		state.emit("turn_end");
		await vi.waitFor(() => expect(runObserver).toHaveBeenCalledTimes(1));
		await vi.waitFor(() => expect(state.runtime.consolidationInFlight).toBe(false));
		expect(state.runtime.observerEmptyBackoff).toMatchObject({ sessionIdentity: "session-a", coverageId: undefined });

		state.emit("turn_end");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(runObserver).toHaveBeenCalledTimes(1);

		await runObserverOnce(state.pi, state.runtime, state.ctx, { forced: true });
		expect(runObserver).toHaveBeenCalledTimes(2);

		state.setEntries([...state.entries(), raw("raw-2", "small")]);
		state.emit("turn_end");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(runObserver).toHaveBeenCalledTimes(2);

		state.setEntries([...state.entries(), raw("raw-3", "y".repeat(1000))]);
		runObserver.mockResolvedValueOnce({ tree: { type: "observation", content: "A durable new requirement arrived after the empty batch.", sourceEntryIds: ["raw-3"] } });
		state.emit("turn_end");
		await vi.waitFor(() => expect(runObserver).toHaveBeenCalledTimes(3));
		await vi.waitFor(() => expect(state.runtime.consolidationInFlight).toBe(false));
		expect(state.runtime.observerEmptyBackoff).toBeUndefined();
	});

	it("does not append after an independent abort arrives after model return", async () => {
		const state = setup([raw("raw-1", "new requirement")]);
		const controller = new AbortController();
		runObserver.mockImplementationOnce(async () => {
			queueMicrotask(() => controller.abort());
			return { tree: { type: "observation", content: "A durable new requirement arrived.", sourceEntryIds: ["raw-1"] } };
		});
		const pending = runObserverOnce(state.pi, state.runtime, state.ctx, { forced: false, signal: controller.signal });
		const outcome = pending.then(() => undefined, (error: unknown) => error);
		await vi.waitFor(() => expect(runObserver).toHaveBeenCalledTimes(1));
		await expect(outcome).resolves.toMatchObject({ name: "AbortError" });
		expect(state.appended).toHaveLength(0);
	});

	it("preserves segmentation due after a partial segmentation event", async () => {
		const a = { id: "aaaaaaaaaaaa", content: "A durable architecture observation with enough detail to persist.", sourceEntryIds: ["raw-a"] };
		const b = { id: "bbbbbbbbbbbb", content: "A second durable implementation observation with enough detail to persist.", sourceEntryIds: ["raw-b"] };
		const root = { id: "s_111111111111" as const, title: "Completed work", summary: "Summarized completed work.", childIds: [a.id, b.id] };
		const memory: Entry = { type: "custom", id: "memory", customType: OM_OBSERVATIONS_RECORDED, data: { version: 1, nodeRecords: [a, b, root], coversUpToId: "raw-b", segmentCheck: "complete" } };
		const state = setup([raw("raw-a", "a"), raw("raw-b", "b"), memory, raw("raw-c", "new")]);
		state.runtime.config = { ...state.runtime.config, segmentEveryObserverRuns: 1 };
		runObserver.mockImplementationOnce(async ({ segmentRequired, tree }) => {
			expect(segmentRequired).toBe(true);
			return { tree: { type: "segment", id: tree.root.id, title: tree.root.title, summary: tree.root.summary, children: [
				{ type: "ref", id: a.id },
				{ type: "observation", content: "A durable new observation with enough detail to persist.", sourceEntryIds: ["raw-c"] },
				{ type: "observation", content: "Invalid provenance should be removed.", sourceEntryIds: ["made-up"] },
			] } };
		});
		await runObserverOnce(state.pi, state.runtime, state.ctx, { forced: false });
		const tree = new MemoryTreeStore().rebuild(state.entries());
		expect(tree.observationBatchesSinceSegmentation).toBe(1);
		expect(state.appended[0]?.data.segmentCheck).toBe("partial");
		state.setEntries([...state.entries(), raw("raw-d", "next")]);
		runObserver.mockImplementationOnce(async ({ segmentRequired }) => {
			expect(segmentRequired).toBe(true);
			return { tree: null };
		});
		await runObserverOnce(state.pi, state.runtime, state.ctx, { forced: false });
	});

	it("uses provider context growth for Observer scheduling when raw growth is small", async () => {
		const observation = { id: "aaaaaaaaaaaa", content: "A durable prior observation with enough detail to persist.", sourceEntryIds: ["raw-a"] };
		const memory: Entry = { type: "custom", id: "memory", customType: OM_OBSERVATIONS_RECORDED, data: { version: 1, nodeRecords: [observation], coversUpToId: "raw-a", segmentCheck: "not_requested" } };
		const assistant: Entry = { type: "message", id: "assistant-1", message: { role: "assistant", content: "done", stopReason: "end_turn", usage: { totalTokens: 100 } } };
		const state = setup([assistant, raw("raw-a", "a"), memory, raw("raw-b", "tiny")]);
		state.runtime.config = { ...state.runtime.config, observeAfterTokens: 10 };
		state.ctx.getContextUsage = vi.fn(() => ({ tokens: 110, contextWindow: 1000 }));
		runObserver.mockResolvedValueOnce({ tree: null });
		registerConsolidationTrigger(state.pi, state.runtime);
		state.emit("turn_end");
		await vi.waitFor(() => expect(runObserver).toHaveBeenCalledTimes(1));
	});

	it("does not append after branch generation changes during the model call", async () => {
		const state = setup([raw("raw-1", "new requirement")]);
		let release!: () => void;
		runObserver.mockImplementationOnce(async () => {
			await new Promise<void>((resolve) => { release = resolve; });
			return { tree: { type: "observation", content: "User added a new durable requirement.", sourceEntryIds: ["raw-1"] } };
		});
		const pending = runObserverOnce(state.pi, state.runtime, state.ctx, { forced: false });
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		state.runtime.invalidateBranch();
		release();
		await expect(pending).rejects.toThrow(/aborted|changed/i);
		expect(state.appended).toHaveLength(0);
	});
});
