import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../src/config.js";
import { registerCompactionHook } from "../src/hooks/compaction-hook.js";
import { OM_OBSERVATIONS_RECORDED, type Entry } from "../src/memory-tree/types.js";

const { runObserverOnce } = vi.hoisted(() => ({ runObserverOnce: vi.fn() }));
vi.mock("../src/hooks/consolidation-trigger.js", () => ({ runObserverOnce: (...args: unknown[]) => runObserverOnce(...args) }));

function setup(entries: Entry[]) {
	let hook: any;
	const pi = { on: vi.fn((event, handler) => { if (event === "session_before_compact") hook = handler; }) } as any;
	const runtime = {
		compactHookInFlight: false,
		configLoaded: true,
		config: { ...DEFAULTS, memoryDepth: 1 },
		ensureConfig: vi.fn(),
		recordConsolidationStageError: vi.fn((_ctx, _phase, error) => error instanceof Error ? error.message : String(error)),
	} as any;
	registerCompactionHook(pi, runtime);
	const notify = vi.fn();
	const ctx = { cwd: "/project", hasUI: true, ui: { notify }, sessionManager: { getBranch: () => entries } };
	const event = { preparation: { firstKeptEntryId: "raw-b", tokensBefore: 1000 }, signal: new AbortController().signal };
	return { hook, runtime, ctx, event, notify };
}

const validEntries = (): Entry[] => {
	const a = { id: "aaaaaaaaaaaa", content: "Investigated a detailed architecture issue and recorded the durable technical findings.", sourceEntryIds: ["raw-a"] };
	const b = { id: "bbbbbbbbbbbb", content: "Implemented the architecture change and verified the detailed behavior with tests.", sourceEntryIds: ["raw-b"] };
	const root = { id: "s_111111111111", title: "Architecture implementation", summary: "Investigated and implemented the architecture.", childIds: [a.id, b.id] };
	return [
		{ type: "message", id: "raw-a", message: { role: "user", content: "a" } },
		{ type: "message", id: "raw-b", message: { role: "user", content: "b" } },
		{ type: "custom", id: "memory", customType: OM_OBSERVATIONS_RECORDED, data: { version: 1, nodeRecords: [a, b, root], coversUpToId: "raw-b", segmentCheck: "complete" } },
	];
};

describe("Segment Memory compaction hook", () => {
	beforeEach(() => runObserverOnce.mockReset());

	it("forces Observer then renders by memoryDepth", async () => {
		const state = setup(validEntries());
		runObserverOnce.mockResolvedValue({ appended: false, warnings: [] });
		const result = await state.hook(state.event, state.ctx);
		expect(runObserverOnce).toHaveBeenCalledWith(expect.anything(), state.runtime, state.ctx, {
			forced: true,
			signal: state.event.signal,
		});
		expect(result.compaction.firstKeptEntryId).toBe("raw-b");
		expect(result.compaction.summary).toContain("# [s_111111111111] Architecture implementation");
		expect(result.compaction.summary).toContain("[aaaaaaaaaaaa]");
		expect(result.compaction.details).toMatchObject({ type: "om.segment-tree.rendered", memoryDepth: 1 });
	});

	it("delegates native compaction when forced Observer succeeds without memory", async () => {
		const state = setup([]);
		runObserverOnce.mockResolvedValue({ appended: false, warnings: [] });
		await expect(state.hook(state.event, state.ctx)).resolves.toBeUndefined();
	});

	it("cancels on forced Observer failure and duplicate hooks", async () => {
		const state = setup(validEntries());
		runObserverOnce.mockImplementationOnce(() => { throw new Error("model unavailable"); });
		await expect(state.hook(state.event, state.ctx)).resolves.toEqual({ cancel: true });
		expect(state.notify).toHaveBeenCalledWith(expect.stringContaining("model unavailable"), "warning");
		state.runtime.compactHookInFlight = true;
		await expect(state.hook(state.event, state.ctx)).resolves.toEqual({ cancel: true });
	});
});
