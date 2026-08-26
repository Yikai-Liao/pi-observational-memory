import { describe, expect, it } from "vitest";
import { applyObserverProposal, MemoryTreeError, MemoryTreeStore } from "../src/memory-tree/store.js";
import { nodeSelfTokenCount } from "../src/memory-tree/node.js";
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

function summaryAtTokenBoundary(childNodes: Array<Observation | Segment>): string {
	const children = childNodes.reduce((total, node) => total + nodeSelfTokenCount(node), 0);
	for (let length = 1; length <= 2_000; length++) {
		const candidate = segment("s_999999999999", childNodes.map((node) => node.id), "Work", "x".repeat(length));
		if (nodeSelfTokenCount(candidate) === children) return candidate.summary;
	}
	throw new Error("could not construct compression boundary");
}

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

	it("rejects nodes unreachable from the sole root", () => {
		const a = observation("aaaaaaaaaaaa", "raw-a");
		const b = observation("bbbbbbbbbbbb", "raw-b");
		const c = observation("cccccccccccc", "raw-c");
		const d = observation("dddddddddddd", "raw-d");
		const root = segment("s_111111111111", [a.id, b.id], "Root", "Done.");
		const orphanA = segment("s_222222222222", ["s_333333333333", c.id], "Orphan A", "A.");
		const orphanB = segment("s_333333333333", [orphanA.id, d.id], "Orphan B", "B.");
		expect(() => new MemoryTreeStore().rebuild([
			source("raw-a"), source("raw-b"), source("raw-c"), source("raw-d"),
			event("event", [a, b, c, d, root, orphanA, orphanB], "raw-d"),
		])).toThrow(/4 node\(s\) are unreachable from root/);
	});

	it("rejects duplicate Segment records in one persisted event", () => {
		const a = observation("aaaaaaaaaaaa", "raw-a");
		const b = observation("bbbbbbbbbbbb", "raw-b");
		const root = segment("s_111111111111", [a.id, b.id], "Root", "A short root summary.");
		const updated = { ...root, title: "Updated root" };
		expect(() => new MemoryTreeStore().rebuild([
			source("raw-a"), source("raw-b"), event("initial", [a, b, root], "raw-b"),
			{ ...event("duplicate", [updated, updated]), data: { version: 1, nodeRecords: [updated, updated], segmentCheck: "complete" } },
		])).toThrow(/repeats node record/);
	});

	it("rejects a Segment whose compression is exactly equal to its children", () => {
		const a = observation("aaaaaaaaaaaa", "raw-a", "A sufficiently detailed first observation.");
		const b = observation("bbbbbbbbbbbb", "raw-b", "A sufficiently detailed second observation.");
		const equal = segment("s_111111111111", [a.id, b.id], "Work", summaryAtTokenBoundary([a, b]));
		expect(() => new MemoryTreeStore().rebuild([
			source("raw-a"), source("raw-b"), event("equal", [a, b, equal], "raw-b"),
		])).toThrow(/not smaller than its direct children/);
	});

	it("applies a Segment revision that changes its childIds", () => {
		const a = observation("aaaaaaaaaaaa", "raw-a");
		const b = observation("bbbbbbbbbbbb", "raw-b");
		const c = observation("cccccccccccc", "raw-c");
		const root = segment("s_111111111111", [a.id, b.id], "Root", "Done.");
		const revised = { ...root, childIds: [a.id, b.id, c.id] };
		const tree = new MemoryTreeStore().rebuild([
			source("raw-a"), source("raw-b"), event("initial", [a, b, root], "raw-b"), source("raw-c"),
			event("revision", [c, revised], "raw-c"),
		]);
		expect(tree.root).toEqual(revised);
		expect(tree.parentByChildId.get(c.id)).toBe(root.id);
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

	it("promotes valid children when an invalid nested Segment is removed", () => {
		const a = observation("aaaaaaaaaaaa", "raw-a");
		const b = observation("bbbbbbbbbbbb", "raw-b");
		const root = segment("s_111111111111", [a.id, b.id], "Root", "Done.");
		const entries = [source("raw-a"), source("raw-b"), event("initial", [a, b, root], "raw-b"), source("raw-c"), source("raw-d")];
		const ids = ["cccccccccccc", "dddddddddddd"];
		const result = applyObserverProposal(new MemoryTreeStore().rebuild(entries), {
			type: "segment", id: root.id, title: root.title, summary: root.summary,
			children: [
				{ type: "ref", id: a.id }, { type: "ref", id: b.id },
				{ type: "segment", title: "bad\nsegment", summary: "Discard this wrapper", children: [
					{ type: "observation", content: "A valid promoted observation.", sourceEntryIds: ["raw-c"] },
					{ type: "observation", content: "Another valid promoted observation.", sourceEntryIds: ["raw-d"] },
				] },
			],
		}, entries, {
			allowedSourceEntryIds: ["raw-c", "raw-d"], coversUpToId: "raw-d", segmentRequested: true,
			createObservationId: () => ids.shift()!,
		});
		expect(result.data?.segmentCheck).toBe("partial");
		expect(result.warnings).toContain("removed invalid Segment proposal; promoted valid children");
		expect((result.tree.root as Segment).childIds).toEqual([a.id, b.id, "cccccccccccc", "dddddddddddd"]);
	});

	it("falls back to existing Root fields and keeps partial cadence after invalid fields", () => {
		const a = observation("aaaaaaaaaaaa", "raw-a");
		const b = observation("bbbbbbbbbbbb", "raw-b");
		const root = segment("s_111111111111", [a.id, b.id], "Original title", "Done.");
		const entries = [source("raw-a"), source("raw-b"), event("initial", [a, b, root], "raw-b")];
		const result = applyObserverProposal(new MemoryTreeStore().rebuild(entries), {
			type: "segment", id: root.id, title: "bad\ntitle", summary: "bad\nsummary",
			children: [{ type: "ref", id: a.id }, { type: "ref", id: b.id }],
		}, entries, { allowedSourceEntryIds: [], segmentRequested: true });
		expect(result.data?.segmentCheck).toBe("partial");
		expect(result.data?.warnings).toEqual(expect.arrayContaining(["kept existing title for s_111111111111", "kept existing summary for s_111111111111"]));
		expect(result.tree.root).toMatchObject({ title: root.title, summary: root.summary });
		const replay = new MemoryTreeStore().rebuild([...entries, { ...event("partial", []), data: result.data }]);
		expect(replay.observationBatchesSinceSegmentation).toBe(1);
	});

	it("canonicalizes and de-duplicates proposal source provenance", () => {
		const result = applyObserverProposal(new MemoryTreeStore().rebuild([]), {
			type: "observation", content: "A durable observation with canonical provenance.", sourceEntryIds: ["raw-b", "raw-a", "raw-b"],
		}, [source("raw-a"), source("raw-b")], {
			allowedSourceEntryIds: ["raw-a", "raw-b"], coversUpToId: "raw-b", segmentRequested: false,
			createObservationId: () => "aaaaaaaaaaaa",
		});
		expect(result.data?.nodeRecords[0]).toMatchObject({ sourceEntryIds: ["raw-a", "raw-b"] });
	});

	it("rejects strict envelope, newline, and ID violations during replay", () => {
		const a = observation("aaaaaaaaaaaa", "raw-a");
		const b = observation("bbbbbbbbbbbb", "raw-b");
		const root = segment("s_111111111111", [a.id, b.id]);
		const base = [source("raw-a"), source("raw-b"), event("valid", [a, b, root], "raw-b")];
		expect(() => new MemoryTreeStore().rebuild([{ ...base[2], data: { ...(base[2] as any).data, extra: true } }])).toThrow(MemoryTreeError);
		expect(() => new MemoryTreeStore().rebuild([{ ...base[2], data: { version: 1, nodeRecords: [{ ...root, summary: "bad\nsummary" }], segmentCheck: "complete" } }])).toThrow(MemoryTreeError);
		expect(() => new MemoryTreeStore().rebuild([{ ...base[2], data: { version: 1, nodeRecords: [{ ...a, id: "AAAAAAAAAAAA" }, b, root], coversUpToId: "raw-b", segmentCheck: "complete" } }])).toThrow(MemoryTreeError);
	});

	it("does not persist a Root-only ordinary proposal after invalid leaves are removed", () => {
		const a = observation("aaaaaaaaaaaa", "raw-a");
		const b = observation("bbbbbbbbbbbb", "raw-b");
		const root = segment("s_111111111111", [a.id, b.id]);
		const entries = [source("raw-a"), source("raw-b"), event("event-a", [a, b, root], "raw-b"), source("raw-c")];
		const tree = new MemoryTreeStore().rebuild(entries);

		const result = applyObserverProposal(tree, {
			type: "segment",
			id: root.id,
			title: root.title,
			summary: root.summary,
			children: [{ type: "observation", content: "A proposed leaf with invalid provenance.", sourceEntryIds: ["made-up-source"] }],
		}, entries, {
			allowedSourceEntryIds: ["raw-c"],
			coversUpToId: "raw-c",
			segmentRequested: false,
		});

		expect(result.data).toBeUndefined();
		expect(result.tree.root).toEqual(root);
		expect(result.warnings).toContain("removed invalid observation proposal");
	});
});
