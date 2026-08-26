import { describe, expect, it } from "vitest";
import { applyObserverProposal, MemoryTreeError, MemoryTreeStore } from "../src/memory-tree/store.js";
import { OM_OBSERVATIONS_RECORDED, type Entry, type Observation, type Segment } from "../src/memory-tree/types.js";

const source = (id: string): Entry => ({ type: "message", id, message: { role: "user", content: id } });
const event = (id: string, nodeRecords: Array<Observation | Segment>, coversUpToId?: string): Entry => ({
	type: "custom",
	id,
	customType: OM_OBSERVATIONS_RECORDED,
	data: {
		version: 1,
		nodeRecords,
		...(coversUpToId ? { coversUpToId } : {}),
		segmentCheck: "not_requested",
	},
});

const observation = (id: string, sourceEntryId: string, content = `A detailed observation backed by ${sourceEntryId} that is deliberately long enough to summarize.`): Observation => ({
	id,
	content,
	sourceEntryIds: [sourceEntryId],
});

const segment = (id: `s_${string}`, childIds: string[], title = "Work", summary = "Completed related work."): Segment => ({ id, title, summary, childIds });

describe("MemoryTreeStore", () => {
	it("promotes the first observation to root and requires a Segment for the second", () => {
		const a = observation("aaaaaaaaaaaa", "raw-a");
		const one = new MemoryTreeStore().rebuild([source("raw-a"), event("event-a", [a], "raw-a")]);
		expect(one.root).toEqual(a);

		const b = observation("bbbbbbbbbbbb", "raw-b");
		expect(() => new MemoryTreeStore().rebuild([
			source("raw-a"),
			event("event-a", [a], "raw-a"),
			source("raw-b"),
			event("event-b", [b], "raw-b"),
		])).toThrow(/Segment root/);

		const root = segment("s_111111111111", [a.id, b.id]);
		const two = new MemoryTreeStore().rebuild([
			source("raw-a"),
			event("event-a", [a], "raw-a"),
			source("raw-b"),
			event("event-b", [b, root], "raw-b"),
		]);
		expect(two.root).toEqual(root);
		expect(two.parentByChildId.get(a.id)).toBe(root.id);
	});

	it("applies later Segment versions and rejects malformed persisted events", () => {
		const a = observation("aaaaaaaaaaaa", "raw-a");
		const b = observation("bbbbbbbbbbbb", "raw-b");
		const root = segment("s_111111111111", [a.id, b.id]);
		const updated = { ...root, title: "Updated work", summary: "Finished the related implementation." };
		const tree = new MemoryTreeStore().rebuild([
			source("raw-a"), source("raw-b"),
			event("event-a", [a, b, root], "raw-b"),
			{ type: "custom", id: "event-b", customType: OM_OBSERVATIONS_RECORDED, data: { version: 1, nodeRecords: [updated], segmentCheck: "complete" } },
		]);
		expect(tree.root).toEqual(updated);
		expect(tree.observationBatchesSinceSegmentation).toBe(0);
		expect(() => new MemoryTreeStore().rebuild([{ type: "custom", id: "bad", customType: OM_OBSERVATIONS_RECORDED, data: {} }])).toThrow(MemoryTreeError);
		expect(() => new MemoryTreeStore().rebuild([{ type: "custom", id: "empty", customType: OM_OBSERVATIONS_RECORDED, data: { version: 1, nodeRecords: [], segmentCheck: "not_requested" } }])).toThrow(MemoryTreeError);
		expect(() => new MemoryTreeStore().rebuild([source("raw-a"), event("extra", [{ ...a, tokenCount: 10 } as any], "raw-a")])).toThrow(MemoryTreeError);
	});

	it("rejects DAGs, missing children, cycles, and source-order changes", () => {
		const a = observation("aaaaaaaaaaaa", "raw-a");
		const b = observation("bbbbbbbbbbbb", "raw-b");
		const c = observation("cccccccccccc", "raw-c");
		const child = segment("s_222222222222", [a.id, b.id], "Child", "Summarized A and B.");
		const shared = segment("s_333333333333", [a.id, c.id], "Shared", "Summarized A and C.");
		const root = segment("s_111111111111", [child.id, shared.id], "Root", "Summarized all work.");
		expect(() => new MemoryTreeStore().rebuild([
			source("raw-a"), source("raw-b"), source("raw-c"),
			event("event", [a, b, c, child, shared, root], "raw-c"),
		])).toThrow(/multiple parents/);

		const missing = segment("s_444444444444", [a.id, "dddddddddddd"]);
		expect(() => new MemoryTreeStore().rebuild([source("raw-a"), event("event", [a, missing], "raw-a")])).toThrow(/missing child/);

		const reversed = segment("s_555555555555", [b.id, a.id]);
		expect(() => new MemoryTreeStore().rebuild([source("raw-a"), source("raw-b"), event("event", [a, b, reversed], "raw-b")])).toThrow(/source ledger order/);
	});
});

describe("applyObserverProposal", () => {
	it("creates the first Observation and then a standard Segment root", () => {
		const store = new MemoryTreeStore();
		const first = applyObserverProposal(store.rebuild([]), {
			type: "observation",
			content: "The first source established a durable architecture requirement.",
			sourceEntryIds: ["raw-a"],
		}, [source("raw-a")], {
			allowedSourceEntryIds: ["raw-a"],
			coversUpToId: "raw-a",
			segmentRequested: false,
			createObservationId: () => "aaaaaaaaaaaa",
		});
		expect(first.data?.nodeRecords).toHaveLength(1);

		const second = applyObserverProposal(first.tree, {
			type: "segment",
			title: "Architecture work",
			summary: "Defined the durable architecture.",
			children: [
				{ type: "ref", id: "aaaaaaaaaaaa" },
				{ type: "observation", content: "The second source confirmed implementation constraints in detail.", sourceEntryIds: ["raw-b"] },
			],
		}, [source("raw-a"), source("raw-b")], {
			allowedSourceEntryIds: ["raw-b"],
			coversUpToId: "raw-b",
			segmentRequested: true,
			createObservationId: () => "bbbbbbbbbbbb",
			createSegmentId: () => "s_111111111111",
		});
		expect(second.tree.root?.id).toBe("s_111111111111");
		expect(second.data?.segmentCheck).toBe("complete");
	});
});
