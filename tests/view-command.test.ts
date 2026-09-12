import { recorded } from "./fixtures/node-records.js";
import { describe, expect, it, vi } from "vitest";
import { registerViewCommand } from "../src/commands/view.js";
import { DEFAULTS } from "../src/config.js";
import { OM_OBSERVATIONS_RECORDED } from "../src/memory-tree/types.js";

const entries = () => {
	const a = { id: "o1", content: "Investigated a detailed issue and preserved important technical findings for future work.", sourceEntryIds: ["raw-a"] };
	const b = { id: "o2", content: "Implemented the detailed fix and verified the important behavior with focused tests.", sourceEntryIds: ["raw-b"] };
	const root = { id: "s1", title: "Issue repair", summary: "Investigated and repaired the issue.", childIds: [a.id, b.id] };
	return [{ type: "message", id: "raw-a" }, { type: "message", id: "raw-b" }, { type: "custom", id: "memory", customType: OM_OBSERVATIONS_RECORDED, data: recorded({ nodeRecords: [a, b, root], coversUpToId: "raw-b", segmentCheck: "complete" }) }];
};

describe("/om:view", () => {
	it("renders visible and current trees and copies the result", async () => {
		let handler: any;
		const pi = { registerCommand: (_name: string, command: any) => { handler = command.handler; } } as any;
		const copy = vi.fn(async () => true);
		registerViewCommand(pi, { configLoaded: true, config: { ...DEFAULTS, memoryDepth: 0 }, ensureConfig: vi.fn() } as any, { copyToClipboard: copy });
		const notify = vi.fn();
		const ctx = { cwd: "/project", sessionManager: { getEntries: entries, getBranch: entries }, ui: { notify } };
		await handler("visible", ctx);
		expect(copy.mock.calls[0][0]).toContain("# [s1] Issue repair");
		expect(copy.mock.calls[0][0]).not.toContain("o1");
		await handler("current", ctx);
		expect(copy.mock.calls[1][0]).toContain("o1");
	});

	it("defaults to visible depth and reports clipboard failures", async () => {
		let handler: any;
		const pi = { registerCommand: (_name: string, command: any) => { handler = command.handler; } } as any;
		registerViewCommand(pi, { configLoaded: true, config: { ...DEFAULTS, memoryDepth: 0 }, ensureConfig: vi.fn() } as any, {
			copyToClipboard: vi.fn(async () => { throw new Error("clipboard unavailable"); }),
		});
		const notify = vi.fn();
		await handler("", { cwd: "/project", sessionManager: { getEntries: entries, getBranch: entries }, ui: { notify } });
		const output = notify.mock.calls[0][0];
		expect(output).toContain("# [s1] Issue repair");
		expect(output).not.toContain("o1");
		expect(output).toContain("Warning: failed to copy /om:view output to clipboard.");
	});

	it("rejects unsupported modes", async () => {
		let handler: any;
		const pi = { registerCommand: (_name: string, command: any) => { handler = command.handler; } } as any;
		const copy = vi.fn();
		registerViewCommand(pi, { configLoaded: true, config: DEFAULTS, ensureConfig: vi.fn() } as any, { copyToClipboard: copy });
		const notify = vi.fn();
		await handler("full", { cwd: "/project", sessionManager: { getEntries: entries, getBranch: entries }, ui: { notify } });
		expect(notify).toHaveBeenCalledWith("Usage: /om:view [visible|current]", "info");
		expect(copy).not.toHaveBeenCalled();
	});
});
