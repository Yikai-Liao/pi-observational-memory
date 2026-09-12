import { describe, expect, it } from "vitest";
import { applyAllocation, emptyAllocation, replayAllocation } from "../src/memory-tree/allocation.js";
import { inspectNode } from "../src/memory-tree/inspect.js";
import { renderMemoryTree } from "../src/memory-tree/render.js";
import { applyObserverProposal, MemoryTreeStore } from "../src/memory-tree/store.js";
import { OM_NODE_IDS_INHERITED, OM_OBSERVATIONS_RECORDED, type Entry, type ObservationsRecordedEntryData, type Segment } from "../src/memory-tree/types.js";

const source = (id: string, parentId: string | null = null): Entry => ({ type: "message", id, parentId, message: { role: "user", content: id } });
const a = { id: "o1", content: "User chose the first architecture.", sourceEntryIds: ["raw-a"] };
const first: ObservationsRecordedEntryData = { version: 2, nodeRecords: [a], highWater: { observation: "1", segment: "0" }, coversUpToId: "raw-a", segmentCheck: "not_requested" };
const commit = (id: string, parentId: string, data: ObservationsRecordedEntryData): Entry => ({ type: "custom", id, parentId, customType: OM_OBSERVATIONS_RECORDED, data });
const branchStart = [source("raw-a"), commit("first", "raw-a", first)];

describe("Session-wide node allocation", () => {
	it("uses separate exact bigint sequences, persists gaps, and rejects reused inherited numbers", () => {
		const entries: Entry[] = [{ type: "custom", id: "fork", customType: OM_NODE_IDS_INHERITED, data: {
			version: 1, sessionId: "forked", sourceSessionId: "original", highWater: { observation: "9007199254740993", segment: "12" },
		} }, source("new-source")];
		const base = new MemoryTreeStore().rebuild(entries);
		const result = applyObserverProposal(base, { type: "observation", content: "A new durable fact.", sourceEntryIds: ["new-source"] }, entries, {
			allowedSourceEntryIds: ["new-source"], coversUpToId: "new-source", segmentRequested: false,
		});
		expect(result.tree.root?.id).toBe("o9007199254740994");
		expect(result.data?.highWater).toEqual({ observation: "9007199254740994", segment: "12" });
		expect(() => applyAllocation(base.allocation, { ...first, highWater: { observation: "9007199254740993", segment: "12" } }, "reuse")).toThrow(/occupied ID/);
		expect(base.allocation.highWater.observation).toBe("9007199254740993");
	});

	it("never rewinds after switching branches and distinguishes off-branch from unknown IDs", () => {
		const b = { id: "o2", content: "Branch A recorded a decision.", sourceEntryIds: ["raw-b"] };
		const rootA: Segment = { id: "s1", title: "A", summary: "A completed.", childIds: ["o1", "o2"] };
		const all = [...branchStart, source("raw-b", "first"), commit("branch-a", "raw-b", {
			version: 2, nodeRecords: [b, rootA], highWater: { observation: "2", segment: "1" }, coversUpToId: "raw-b", segmentCheck: "complete",
		}), source("raw-c", "first")];
		const branch = [...branchStart, all.at(-1)!];
		const tree = new MemoryTreeStore().rebuild(branch, all);
		expect(tree.root?.id).toBe("o1");
		expect(() => inspectNode(tree, "s1")).toThrow(/does not belong to the current branch/);
		expect(() => inspectNode(tree, "s99")).toThrow(/Unknown/);
		const result = applyObserverProposal(tree, { type: "segment", title: "B", summary: "B completed.", children: [
			{ type: "ref", id: "o1" }, { type: "observation", content: "Branch B recorded another decision.", sourceEntryIds: ["raw-c"] },
		] }, branch, { allowedSourceEntryIds: ["raw-c"], coversUpToId: "raw-c", segmentRequested: true });
		expect(result.tree.root).toMatchObject({ id: "s2", childIds: ["o1", "o3"] });
		const event = commit("branch-b", "raw-c", result.data!);
		const restored = new MemoryTreeStore().rebuild([...branch, event], [...all, event]);
		expect(restored.root).toEqual(result.tree.root);
		expect(restored.allocation.highWater).toEqual({ observation: "3", segment: "2" });
		// Independent Sessions start their own sequences.
		expect(new MemoryTreeStore().rebuild(branchStart).root?.id).toBe("o1");
	});

	it("rejects conflicting Segment identity on another branch without mixing the trees", () => {
		const records: ObservationsRecordedEntryData = { version: 2, nodeRecords: [a, { id: "o2", content: "Other fact.", sourceEntryIds: ["raw-a"] },
			{ id: "s1", title: "Root", summary: "Work.", childIds: ["o1", "o2"] }], highWater: { observation: "2", segment: "1" }, coversUpToId: "raw-a", segmentCheck: "complete" };
		const entries = [source("raw-a"), commit("a", "raw-a", records), source("elsewhere"), commit("b", "elsewhere", {
			...records, nodeRecords: [records.nodeRecords[2]!], coversUpToId: undefined,
		})];
		expect(() => replayAllocation(entries)).toThrow(/another branch/);
	});

	it.each([
		["old envelope", { ...first, version: 1 }],
		["missing water", { ...first, highWater: undefined }],
		["numeric water", { ...first, highWater: { observation: 1, segment: "0" } }],
		["padded water", { ...first, highWater: { observation: "01", segment: "0" } }],
		["water with trailing newline", { ...first, highWater: { observation: "1\n", segment: "0" } }],
		["negative water", { ...first, highWater: { observation: "1", segment: "-1" } }],
		["unknown field", { ...first, refBindings: [] }],
		["old node ID", { ...first, nodeRecords: [{ ...a, id: "aaaaaaaaaaaa" }] }],
		["type mismatch", { ...first, nodeRecords: [{ ...a, id: "s1" }] }],
		["padded node ID", { ...first, nodeRecords: [{ ...a, id: "o01" }] }],
		["zero node ID", { ...first, nodeRecords: [{ ...a, id: "o0" }] }],
		["node ID with trailing newline", { ...first, nodeRecords: [{ ...a, id: "o1\n" }] }],
		["duplicate record", { ...first, nodeRecords: [a, a] }],
		["insufficient water", { ...first, highWater: { observation: "0", segment: "0" } }],
	])("strictly rejects %s without partial application", (_label, data) => {
		const state = emptyAllocation();
		expect(() => applyAllocation(state, data as any, "bad")).toThrow();
		expect(state).toEqual(emptyAllocation());
	});

	it("rejects water rollback, Observation updates, and malformed/repeated Fork snapshots", () => {
		const state = applyAllocation(emptyAllocation(), first, "first");
		expect(() => applyAllocation(state, { version: 2, nodeRecords: [], highWater: { observation: "0", segment: "0" }, segmentCheck: "complete" }, "rollback")).toThrow(/decreased/);
		expect(() => applyAllocation(state, first, "duplicate")).toThrow(/cannot be updated/);
		const fork: Entry = { type: "custom", id: "fork", customType: OM_NODE_IDS_INHERITED, data: { version: 1, sessionId: "target", sourceSessionId: "source", highWater: { observation: "10", segment: "2" } } };
		expect(() => replayAllocation([fork, { ...fork, id: "twice" }])).toThrow(/repeated Fork/);
		expect(() => replayAllocation([{ ...fork, data: { ...(fork.data as any), extra: true } }])).toThrow(/malformed/);
	});

	it("keeps IDs across root promotion, grouping, summary updates, rendering and replay", () => {
		const base = new MemoryTreeStore().rebuild(branchStart);
		const entries = [...branchStart, source("raw-b", "first")];
		const next = applyObserverProposal(base, { type: "segment", title: "Work", summary: "Done.", children: [
			{ type: "ref", id: "o1" }, { type: "observation", content: "User requested a second change.", sourceEntryIds: ["raw-b"] },
		] }, entries, { allowedSourceEntryIds: ["raw-b"], coversUpToId: "raw-b", segmentRequested: false });
		const fullEntries = [...entries, commit("promote", "raw-b", next.data!)];
		const tree = new MemoryTreeStore().rebuild(fullEntries);
		const grouped = applyObserverProposal(tree, { type: "segment", id: "s1", title: "Updated", summary: "Finished.", children: [
			{ type: "segment", title: "Phase", summary: "Both done.", children: [{ type: "ref", id: "o1" }, { type: "ref", id: "o2" }] },
		] }, fullEntries, { allowedSourceEntryIds: [], segmentRequested: true });
		// Root needs at least two children; an invalid whole-root group is rejected.
		expect(grouped.tree.allocation.birthEntryById.has("s2")).toBe(false);
		const updated = applyObserverProposal(tree, { type: "segment", id: "s1", title: "Updated", summary: "Finished.", children: [] }, fullEntries,
			{ allowedSourceEntryIds: [], segmentRequested: true });
		expect(updated.tree.root).toMatchObject({ id: "s1", title: "Updated", childIds: ["o1", "o2"] });
		expect(updated.data?.highWater).toEqual({ observation: "2", segment: "1" });
		for (const depth of [0, 1, 5, 0]) {
			renderMemoryTree(updated.tree, depth);
			expect(updated.tree.observationsById.get("o1")).toEqual(a);
		}
		expect(new MemoryTreeStore().rebuild([...fullEntries, commit("update", "promote", updated.data!)]).root).toEqual(updated.tree.root);
	});
});
