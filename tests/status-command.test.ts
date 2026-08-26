import { describe, expect, it, vi } from "vitest";
import { registerStatusCommand } from "../src/commands/status.js";
import { DEFAULTS } from "../src/config.js";
import { OM_OBSERVATIONS_RECORDED } from "../src/memory-tree/types.js";

function memoryEntries(): any[] {
	const a = { id: "aaaaaaaaaaaa", content: "Investigated a detailed issue and recorded the durable technical findings for later work.", sourceEntryIds: ["raw-a"] };
	const b = { id: "bbbbbbbbbbbb", content: "Implemented the detailed fix and verified the durable behavior with focused tests.", sourceEntryIds: ["raw-b"] };
	const root = { id: "s_111111111111", title: "Issue repair", summary: "Investigated and repaired the issue.", childIds: [a.id, b.id] };
	return [{ type: "message", id: "raw-a" }, { type: "message", id: "raw-b" }, { type: "custom", id: "memory", customType: OM_OBSERVATIONS_RECORDED, data: { version: 1, nodeRecords: [a, b, root], coversUpToId: "raw-b", segmentCheck: "complete" } }];
}

describe("/om:status", () => {
	it("reports tree, cadence, rendering, and validation", async () => {
		let handler: any;
		const pi = { registerCommand: vi.fn((_name, command) => { handler = command.handler; }) } as any;
		const runtime = { configLoaded: true, config: DEFAULTS, ensureConfig: vi.fn(), consolidationInFlight: false, observerEmptyBackoff: { tokensAtEmpty: 12_000 } } as any;
		registerStatusCommand(pi, runtime);
		const notify = vi.fn();
		await handler("", { cwd: "/project", model: { contextWindow: 100_000 }, sessionManager: { getBranch: memoryEntries }, ui: { notify } });
		const output = notify.mock.calls[0][0];
		expect(output).toContain("Observations: 2");
		expect(output).toContain("Segments: 1");
		expect(output).toContain("Render depth: 2");
		expect(output).toContain("Next segmentation: 0 / 2");
		expect(output).toContain("Observer retry backoff: active");
		expect(output).toContain("Tree validation: valid");
	});

	it("reports passive mode", async () => {
		let handler: any;
		const pi = { registerCommand: (_name: string, command: any) => { handler = command.handler; } } as any;
		registerStatusCommand(pi, { configLoaded: true, config: { ...DEFAULTS, passive: true }, ensureConfig: vi.fn() } as any);
		const notify = vi.fn();
		await handler("", { cwd: "/project", sessionManager: { getBranch: memoryEntries }, ui: { notify } });
		expect(notify.mock.calls[0][0]).toContain("Passive: background Observer and auto-compaction disabled");
	});

	it("reports malformed V4 memory without rendering it", async () => {
		let handler: any;
		const pi = { registerCommand: (_name: string, command: any) => { handler = command.handler; } } as any;
		registerStatusCommand(pi, { configLoaded: true, config: DEFAULTS, ensureConfig: vi.fn() } as any);
		const notify = vi.fn();
		await handler("", { cwd: "/project", sessionManager: { getBranch: () => [{ type: "custom", id: "bad", customType: OM_OBSERVATIONS_RECORDED, data: {} }] }, ui: { notify } });
		expect(notify.mock.calls[0][0]).toContain("Tree validation: invalid");
	});
});
