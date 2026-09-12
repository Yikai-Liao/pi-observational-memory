import { recorded } from "./fixtures/node-records.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import observationalMemory from "../src/index.js";
import { exportMemory } from "../src/memory-tree/export.js";
import { inspectNode } from "../src/memory-tree/inspect.js";
import { MemoryTreeStore } from "../src/memory-tree/store.js";
import { OM_OBSERVATIONS_RECORDED, type Entry } from "../src/memory-tree/types.js";
import { SessionCatalog } from "../src/sessions/catalog.js";
import { normalizeOmReadArguments, OM_READ_SCHEMA, registerOmReadTool } from "../src/tools/om-read.js";
import { normalizeOmSessionsArguments, OM_SESSIONS_SCHEMA, registerOmSessionsTool } from "../src/tools/om-sessions.js";

const entries = (summary = "Located and fixed the release issue."): Entry[] => {
	const a = { id: "o1", content: "Investigated the detailed release issue and located the durable root cause.", sourceEntryIds: ["raw-a"] };
	const b = { id: "o2", content: "Implemented the detailed release repair and verified its durable behavior.", sourceEntryIds: ["raw-b"] };
	const root = { id: "s1", title: "Release repair", summary, childIds: [a.id, b.id] };
	return [
		{ type: "message", id: "raw-a" }, { type: "message", id: "raw-b" },
		{ type: "custom", id: "memory", customType: OM_OBSERVATIONS_RECORDED, data: recorded({ nodeRecords: [a, b, root], coversUpToId: "raw-b", segmentCheck: "complete" }) },
	];
};

const nestedEntries = (): Entry[] => {
	const a = { id: "o1", content: "Investigated the detailed release issue and located the durable root cause.", sourceEntryIds: ["raw-a"] };
	const b = { id: "o2", content: "Implemented the detailed release repair and verified its durable behavior.", sourceEntryIds: ["raw-b"] };
	const c = { id: "o3", content: "Documented the final release behavior for future maintenance.", sourceEntryIds: ["raw-c"] };
	const child = { id: "s2", title: "Repair phase", summary: "Fixed release behavior.", childIds: [a.id, b.id] };
	const root = { id: "s1", title: "Release project", summary: "Completed release work.", childIds: [child.id, c.id] };
	return [
		{ type: "message", id: "raw-a" }, { type: "message", id: "raw-b" }, { type: "message", id: "raw-c" },
		{ type: "custom", id: "memory", customType: OM_OBSERVATIONS_RECORDED, data: recorded({ nodeRecords: [a, b, c, child, root], coversUpToId: "raw-c", segmentCheck: "complete" }) },
	];
};

function manager(summary?: string, sessionId = "session-a") {
	return { getEntries: () => entries(summary), getBranch: () => entries(summary), getSessionName: () => "Release", getSessionId: () => sessionId };
}

describe("memory inspection and export", () => {
	it("reads depth 0, full subtrees, and source provenance", () => {
		const tree = new MemoryTreeStore().rebuild(entries());
		const shallow = inspectNode(tree, undefined, 0, true) as any;
		expect(shallow.children[0]).toMatchObject({ id: "o1", kind: "observation" });
		const full = inspectNode(tree, undefined, -1, true) as any;
		expect(full.children[0].sourceEntryIds).toEqual(["raw-a"]);
	});

	it("exports independently parseable JSONL that reconstructs parents", () => {
		const tree = new MemoryTreeStore().rebuild(entries());
		const lines = exportMemory(tree, { sessionId: "session-a", name: "Release", cwd: "/work/project" }, { depth: -1, format: "jsonl" })
			.split("\n").map((line) => JSON.parse(line));
		expect(lines[0]).toMatchObject({ recordType: "session", sessionId: "session-a", cwd: "/work/project" });
		expect(lines[1]).toMatchObject({ nodeId: "s1", parentId: null, kind: "segment", summary: "Located and fixed the release issue." });
		expect(lines[2]).toMatchObject({ nodeId: "o1", parentId: "s1", position: 0, sourceEntryIds: ["raw-a"] });
		expect(lines[3]).toMatchObject({ nodeId: "o2", parentId: "s1", position: 1 });
	});

	it("honors nodeId, depth, summary, and public JSON/Markdown formats", () => {
		const tree = new MemoryTreeStore().rebuild(nestedEntries());
		const child = inspectNode(tree, "s2", -1, false) as any;
		expect(child).toMatchObject({ id: "s2", title: "Repair phase" });
		expect(child.summary).toBeUndefined();
		const shallow = inspectNode(tree, undefined, 0, false) as any;
		expect(shallow.children[0]).toEqual({ kind: "segment", id: "s2", preview: "Repair phase" });
		expect(shallow.children[1]).toEqual({ kind: "observation", id: "o3", preview: expect.stringContaining("Documented") });
		const preview = exportMemory(tree, { sessionId: "session-a" }, { depth: 0 });
		expect(preview).toContain("- [s2] Repair phase");
		expect(preview).toContain("- [o3]");
		expect(preview).not.toContain("[s1]");
		const json = JSON.parse(exportMemory(tree, { sessionId: "session-a" }, { format: "json", depth: 0, includeSummary: false }));
		expect(json).toMatchObject({ kind: "segment", id: "s1" });
		expect(json.summary).toBeUndefined();
		const markdown = exportMemory(tree, { sessionId: "session-a" }, { format: "markdown", depth: 1 });
		expect(markdown).toContain("# Release project");
		expect(markdown).toContain("## Repair phase");
		expect(markdown.indexOf("## Repair phase")).toBeLessThan(markdown.indexOf("[o3]"));
	});

	it.each(["o0", "s01", "S1", " o1", "o1 ", "o1\n", "s_111111111111", "aaaaaaaaaaaa"])("rejects noncanonical tool IDs %s in every format", (nodeId) => {
		const tree = new MemoryTreeStore().rebuild(entries());
		for (const format of ["markdown", "json", "jsonl"] as const) {
			expect(() => exportMemory(tree, { sessionId: "session-a" }, { nodeId, format })).toThrow(/Invalid node ID/);
		}
	});

	it("applies JSONL depth cutoff and omits summaries when requested", () => {
		const tree = new MemoryTreeStore().rebuild(nestedEntries());
		const lines = exportMemory(tree, { sessionId: "session-a" }, { format: "jsonl", depth: 1, includeSummary: false })
			.split("\n").map((line) => JSON.parse(line));
		expect(lines.slice(1).map((line) => line.nodeId)).toEqual(["s1", "s2", "o3"]);
		expect(lines[2]).toMatchObject({ parentId: "s1", position: 0, kind: "segment" });
		expect(lines[3]).toMatchObject({ parentId: "s1", position: 1, sourceEntryIds: ["raw-c"] });
		expect(lines[2].summary).toBeUndefined();
	});
});

describe("SessionCatalog", () => {
	it("filters by directory boundary and all Root keywords, then resolves exact IDs across cwd", async () => {
		const info = {
			path: "/sessions/a.jsonl", id: "session-a", cwd: "/work/project", name: "Release",
			created: new Date("2026-01-01"), modified: new Date("2026-01-02"), messageCount: 2, firstMessage: "", allMessagesText: "",
		};
		const partial = { ...info, path: "/sessions/partial.jsonl", id: "session-partial" };
		const api = {
			listAll: vi.fn(async () => [partial, info]),
			open: vi.fn((path: string) => path === partial.path
				? manager("Release issue remains under investigation.", partial.id)
				: manager()),
		} as any;
		const catalog = new SessionCatalog(api);
		await expect(catalog.list("/work", ["release", "fixed"])).resolves.toMatchObject([{ sessionId: "session-a" }]);
		await expect(catalog.list("/work/pro", [])).resolves.toHaveLength(0);
		await expect(catalog.locate("session-a")).resolves.toMatchObject({ info });
	});

	it("maps parents, excludes sibling prefixes, and omits unreadable discovery entries", async () => {
		const base = {
			path: "/sessions/parent.jsonl", id: "parent", cwd: "/work/project", name: "Parent",
			created: new Date("2026-01-01"), modified: new Date("2026-01-02"), messageCount: 2, firstMessage: "", allMessagesText: "",
		};
		const child = { ...base, path: "/sessions/child.jsonl", id: "child", cwd: "/work/project/child", parentSessionPath: base.path };
		const sibling = { ...base, path: "/sessions/sibling.jsonl", id: "sibling", cwd: "/workshop/project" };
		const broken = { ...base, path: "/sessions/broken.jsonl", id: "broken", cwd: "/work/broken" };
		const api = {
			listAll: vi.fn(async () => [base, child, sibling, broken]),
			open: vi.fn((path: string) => {
				if (path === broken.path) throw new Error("unreadable");
				return manager(undefined, path === child.path ? child.id : base.id);
			}),
		} as any;
		const catalog = new SessionCatalog(api);
		const listed = await catalog.list("/work");
		expect(listed.map((item) => item.sessionId).sort()).toEqual(["child", "parent"]);
		expect(listed.find((item) => item.sessionId === "child")?.parentSessionId).toBe("parent");
		await expect(catalog.locate("child")).resolves.toMatchObject({ parentSessionId: "parent" });
	});
});

describe("memory tools", () => {
	it("normalizes Luna-filled optional arguments to documented defaults", () => {
		expect(normalizeOmReadArguments({ sessionId: "current", nodeId: null, outputPath: null, depth: 1 })).toEqual({ depth: 1 });
		expect(normalizeOmSessionsArguments({ path: "", keywords: null })).toEqual({});
	});

	it("registers schemas, normalizers, discovery arguments, and complete file output", async () => {
		const tools: any[] = [];
		const pi = { registerTool: (tool: any) => tools.push(tool) } as any;
		const catalog = { list: vi.fn(async () => [{ sessionId: "session-a" }]), locate: vi.fn() } as any;
		registerOmSessionsTool(pi, catalog);
		registerOmReadTool(pi, catalog);
		expect(tools.map((tool) => tool.name)).toEqual(["om_sessions", "om_read"]);
		expect(tools[0]).toMatchObject({ parameters: OM_SESSIONS_SCHEMA, prepareArguments: normalizeOmSessionsArguments });
		expect(tools[1]).toMatchObject({ parameters: OM_READ_SCHEMA, prepareArguments: normalizeOmReadArguments });
		const context = { cwd: mkdtempSync(join(tmpdir(), "om-read-")), sessionManager: manager() };
		const sessionsResult = await tools[0].execute("id", { path: "/work/acme", keywords: ["release", "fixed"] }, undefined, undefined, context);
		expect(catalog.list).toHaveBeenCalledWith("/work/acme", ["release", "fixed"]);
		expect(sessionsResult.details.sessions).toHaveLength(1);
		const readResult = await tools[1].execute("id", { depth: -1, format: "jsonl", outputPath: "memory.jsonl" }, undefined, undefined, context);
		expect(readResult.details.path).toBe(join(context.cwd, "memory.jsonl"));
		expect(readFileSync(readResult.details.path, "utf8").split("\n")).toHaveLength(4);
	});

	it("routes exact sessions and forwards node inspection options", async () => {
		const tools: any[] = [];
		const remoteTree = new MemoryTreeStore().rebuild(nestedEntries());
		const catalog = { list: vi.fn(), locate: vi.fn(async () => ({
			tree: remoteTree,
			info: { id: "remote", cwd: "/remote", name: "Remote" },
			name: "Remote",
		})) } as any;
		registerOmReadTool({ registerTool: (tool: any) => tools.push(tool) } as any, catalog);
		const context = { cwd: "/current", sessionManager: manager("Current session summary.", "current") };
		const result = await tools[0].execute("id", {
			sessionId: "remote", nodeId: "s2", depth: 0, includeSummary: false, format: "json",
		}, undefined, undefined, context);
		expect(catalog.locate).toHaveBeenCalledWith("remote");
		const output = JSON.parse(result.content[0].text);
		expect(output).toMatchObject({ id: "s2", title: "Repair phase" });
		expect(output.summary).toBeUndefined();
		expect(output.children[0]).toHaveProperty("preview");
		expect(result.details.sessionId).toBe("remote");
	});

	it("truncates oversized inline reads and session discovery", async () => {
		const tools: any[] = [];
		const huge = "x".repeat(150_000);
		const hugeEntries = [
			{ type: "message", id: "raw-huge" },
			{ type: "custom", id: "memory", customType: OM_OBSERVATIONS_RECORDED, data: recorded({ nodeRecords: [{ id: "o1", content: huge, sourceEntryIds: ["raw-huge"] }], coversUpToId: "raw-huge", segmentCheck: "not_requested" }) },
		] as Entry[];
		const catalog = { list: vi.fn(async () => Array.from({ length: 1_000 }, (_, index) => ({ sessionId: `session-${index}`, root: { summary: huge.slice(0, 100) } }))), locate: vi.fn() } as any;
		const pi = { registerTool: (tool: any) => tools.push(tool) } as any;
		registerOmSessionsTool(pi, catalog);
		registerOmReadTool(pi, catalog);
		const context = { cwd: "/work", sessionManager: { getEntries: () => hugeEntries, getBranch: () => hugeEntries, getSessionId: () => "current" } };
		const sessions = await tools[0].execute("id", {}, undefined, undefined, context);
		const read = await tools[1].execute("id", {}, undefined, undefined, context);
		expect(sessions.details.truncated).toBe(true);
		expect(sessions.content[0].text).toContain("[Output truncated:");
		expect(read.details.truncated).toBe(true);
		expect(read.content[0].text).toContain("[Output truncated. Use outputPath");
	});

	it("registers both tools through the extension entry point", () => {
		const names: string[] = [];
		observationalMemory({
			on: vi.fn(), registerCommand: vi.fn(), registerTool: (tool: any) => names.push(tool.name),
		} as any);
		expect(new Set(names)).toEqual(new Set(["om_sessions", "om_read"]));
	});
});
