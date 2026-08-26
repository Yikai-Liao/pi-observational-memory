import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { exportMemory } from "../src/memory-tree/export.js";
import { inspectNode } from "../src/memory-tree/inspect.js";
import { MemoryTreeStore } from "../src/memory-tree/store.js";
import { OM_OBSERVATIONS_RECORDED, type Entry } from "../src/memory-tree/types.js";
import { SessionCatalog } from "../src/sessions/catalog.js";
import { registerOmReadTool } from "../src/tools/om-read.js";
import { registerOmSessionsTool } from "../src/tools/om-sessions.js";

const entries = (): Entry[] => {
	const a = { id: "aaaaaaaaaaaa", content: "Investigated the detailed release issue and located the durable root cause.", sourceEntryIds: ["raw-a"] };
	const b = { id: "bbbbbbbbbbbb", content: "Implemented the detailed release repair and verified its durable behavior.", sourceEntryIds: ["raw-b"] };
	const root = { id: "s_111111111111", title: "Release repair", summary: "Located and fixed the release issue.", childIds: [a.id, b.id] };
	return [
		{ type: "message", id: "raw-a" }, { type: "message", id: "raw-b" },
		{ type: "custom", id: "memory", customType: OM_OBSERVATIONS_RECORDED, data: { version: 1, nodeRecords: [a, b, root], coversUpToId: "raw-b", segmentCheck: "complete" } },
	];
};

function manager() {
	return { getBranch: () => entries(), getSessionName: () => "Release", getSessionId: () => "session-a" };
}

describe("memory inspection and export", () => {
	it("reads depth 0, full subtrees, and source provenance", () => {
		const tree = new MemoryTreeStore().rebuild(entries());
		const shallow = inspectNode(tree, undefined, 0, true) as any;
		expect(shallow.children[0]).toMatchObject({ id: "aaaaaaaaaaaa", kind: "observation" });
		const full = inspectNode(tree, undefined, -1, true) as any;
		expect(full.children[0].sourceEntryIds).toEqual(["raw-a"]);
	});

	it("exports independently parseable JSONL that reconstructs parents", () => {
		const tree = new MemoryTreeStore().rebuild(entries());
		const lines = exportMemory(tree, { sessionId: "session-a", name: "Release" }, { depth: -1, format: "jsonl" })
			.split("\n").map((line) => JSON.parse(line));
		expect(lines[0]).toMatchObject({ recordType: "session", sessionId: "session-a" });
		expect(lines[1]).toMatchObject({ nodeId: "s_111111111111", parentId: null, kind: "segment" });
		expect(lines[2]).toMatchObject({ nodeId: "aaaaaaaaaaaa", parentId: "s_111111111111", position: 0 });
	});
});

describe("SessionCatalog", () => {
	it("filters by directory boundary and all Root keywords, then resolves exact IDs across cwd", async () => {
		const info = {
			path: "/sessions/a.jsonl", id: "session-a", cwd: "/work/project", name: "Release",
			created: new Date("2026-01-01"), modified: new Date("2026-01-02"), messageCount: 2, firstMessage: "", allMessagesText: "",
		};
		const api = { listAll: vi.fn(async () => [info]), open: vi.fn(() => manager()) } as any;
		const catalog = new SessionCatalog(api);
		await expect(catalog.list("/work", ["release", "fixed"])).resolves.toHaveLength(1);
		await expect(catalog.list("/work/pro", [])).resolves.toHaveLength(0);
		await expect(catalog.locate("session-a")).resolves.toMatchObject({ info });
	});
});

describe("memory tools", () => {
	it("registers discovery and writes complete om_read output", async () => {
		const tools: any[] = [];
		const pi = { registerTool: (tool: any) => tools.push(tool) } as any;
		const catalog = { list: vi.fn(async () => [{ sessionId: "session-a" }]), locate: vi.fn() } as any;
		registerOmSessionsTool(pi, catalog);
		registerOmReadTool(pi, catalog);
		expect(tools.map((tool) => tool.name)).toEqual(["om_sessions", "om_read"]);
		const context = { cwd: mkdtempSync(join(tmpdir(), "om-read-")), sessionManager: manager() };
		const sessionsResult = await tools[0].execute("id", {}, undefined, undefined, context);
		expect(sessionsResult.details.sessions).toHaveLength(1);
		const readResult = await tools[1].execute("id", { depth: -1, format: "jsonl", outputPath: "memory.jsonl" }, undefined, undefined, context);
		expect(readResult.details.path).toBe(join(context.cwd, "memory.jsonl"));
		expect(readFileSync(readResult.details.path, "utf8").split("\n")).toHaveLength(4);
	});
});
