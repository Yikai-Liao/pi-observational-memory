import { recorded } from "./fixtures/node-records.js";
import { describe, expect, it } from "vitest";
import { applyObserverProposal, MemoryTreeError, MemoryTreeStore } from "../src/memory-tree/store.js";
import { OM_OBSERVATIONS_RECORDED, type Entry, type Observation, type Segment } from "../src/memory-tree/types.js";

const source = (id: string): Entry => ({ type: "message", id, message: { role: "user", content: id } });
const event = (id: string, nodeRecords: Array<Observation | Segment>, coversUpToId?: string): Entry => ({
	type: "custom",
	id,
	customType: OM_OBSERVATIONS_RECORDED,
	data: recorded({
		nodeRecords,
		...(coversUpToId ? { coversUpToId } : {}),
		segmentCheck: "not_requested",
	}),
});

const observation = (id: string, sourceEntryId: string, content = `A detailed observation backed by ${sourceEntryId} that is deliberately long enough to summarize.`): Observation => ({
	id,
	content,
	sourceEntryIds: [sourceEntryId],
});

const segment = (id: `s${string}`, childIds: string[], title = "Work", summary = "Completed related work."): Segment => ({ id, title, summary, childIds });

describe("MemoryTreeStore", () => {
	it("promotes the first observation to root and requires a Segment for the second", () => {
		const a = observation("o1", "raw-a");
		const one = new MemoryTreeStore().rebuild([source("raw-a"), event("event-a", [a], "raw-a")]);
		expect(one.root).toEqual(a);

		const b = observation("o2", "raw-b");
		expect(() => new MemoryTreeStore().rebuild([
			source("raw-a"),
			event("event-a", [a], "raw-a"),
			source("raw-b"),
			event("event-b", [b], "raw-b"),
		])).toThrow(/Segment root/);

		const root = segment("s1", [a.id, b.id]);
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
		const a = observation("o1", "raw-a");
		const b = observation("o2", "raw-b");
		const root = segment("s1", [a.id, b.id]);
		const updated = { ...root, title: "Updated work", summary: "Finished the related implementation." };
		const tree = new MemoryTreeStore().rebuild([
			source("raw-a"), source("raw-b"),
			event("event-a", [a, b, root], "raw-b"),
			{ type: "custom", id: "event-b", customType: OM_OBSERVATIONS_RECORDED, data: recorded({ nodeRecords: [updated], segmentCheck: "complete" }) },
		]);
		expect(tree.root).toEqual(updated);
		expect(tree.observationBatchesSinceSegmentation).toBe(0);
		expect(() => new MemoryTreeStore().rebuild([{ type: "custom", id: "bad", customType: OM_OBSERVATIONS_RECORDED, data: {} }])).toThrow(MemoryTreeError);
		expect(() => new MemoryTreeStore().rebuild([{ type: "custom", id: "empty", customType: OM_OBSERVATIONS_RECORDED, data: recorded({ nodeRecords: [], segmentCheck: "not_requested" }) }])).toThrow(MemoryTreeError);
		expect(() => new MemoryTreeStore().rebuild([source("raw-a"), event("extra", [{ ...a, tokenCount: 10 } as any], "raw-a")])).toThrow(MemoryTreeError);
	});

	it("rejects DAGs, missing children, cycles, and source-order changes", () => {
		const a = observation("o1", "raw-a");
		const b = observation("o2", "raw-b");
		const c = observation("o3", "raw-c");
		const child = segment("s2", [a.id, b.id], "Child", "Summarized A and B.");
		const shared = segment("s3", [a.id, c.id], "Shared", "Summarized A and C.");
		const root = segment("s1", [child.id, shared.id], "Root", "Summarized all work.");
		expect(() => new MemoryTreeStore().rebuild([
			source("raw-a"), source("raw-b"), source("raw-c"),
			event("event", [a, b, c, child, shared, root], "raw-c"),
		])).toThrow(/multiple parents/);

		const missing = segment("s4", [a.id, "o4"]);
		expect(() => new MemoryTreeStore().rebuild([source("raw-a"), event("event", [a, missing], "raw-a")])).toThrow(/missing child/);

		const reversed = segment("s5", [b.id, a.id]);
		expect(() => new MemoryTreeStore().rebuild([source("raw-a"), source("raw-b"), event("event", [a, b, reversed], "raw-b")])).toThrow(/source ledger order/);
	});

	it("rejects nodes unreachable from the sole root", () => {
		const a = observation("o1", "raw-a");
		const b = observation("o2", "raw-b");
		const c = observation("o3", "raw-c");
		const d = observation("o4", "raw-d");
		const root = segment("s1", [a.id, b.id], "Root", "Done.");
		const orphanA = segment("s2", ["s3", c.id], "Orphan A", "A.");
		const orphanB = segment("s3", [orphanA.id, d.id], "Orphan B", "B.");
		expect(() => new MemoryTreeStore().rebuild([
			source("raw-a"), source("raw-b"), source("raw-c"), source("raw-d"),
			event("event", [a, b, c, d, root, orphanA, orphanB], "raw-d"),
		])).toThrow(/4 node\(s\) are unreachable from root/);
	});

	it("rejects duplicate Segment records in one persisted event", () => {
		const a = observation("o1", "raw-a");
		const b = observation("o2", "raw-b");
		const root = segment("s1", [a.id, b.id], "Root", "A short root summary.");
		const updated = { ...root, title: "Updated root" };
		expect(() => new MemoryTreeStore().rebuild([
			source("raw-a"), source("raw-b"), event("initial", [a, b, root], "raw-b"),
			{ ...event("duplicate", [updated, updated]), data: recorded({ nodeRecords: [updated, updated], segmentCheck: "complete" }) },
		])).toThrow(/repeats node record/);
	});

	it("does not enforce prompt compression budgets while replaying persisted Segments", () => {
		const a = observation("o1", "raw-a", "First observation.");
		const b = observation("o2", "raw-b", "Second observation.");
		const verbose = segment("s1", [a.id, b.id], "Work", "x".repeat(2_000));
		const tree = new MemoryTreeStore().rebuild([
			source("raw-a"), source("raw-b"), event("verbose", [a, b, verbose], "raw-b"),
		]);
		expect(tree.root).toEqual(verbose);
	});

	it("applies a Segment revision that changes its childIds", () => {
		const a = observation("o1", "raw-a");
		const b = observation("o2", "raw-b");
		const c = observation("o3", "raw-c");
		const root = segment("s1", [a.id, b.id], "Root", "Done.");
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
			createObservationId: () => "o1",
		});
		expect(first.data?.nodeRecords).toHaveLength(1);

		const second = applyObserverProposal(first.tree, {
			type: "segment",
			title: "Architecture work",
			summary: "Defined the durable architecture.",
			children: [
				{ type: "ref", id: "o1" },
				{ type: "observation", content: "The second source confirmed implementation constraints in detail.", sourceEntryIds: ["raw-b"] },
			],
		}, [source("raw-a"), source("raw-b")], {
			allowedSourceEntryIds: ["raw-b"],
			coversUpToId: "raw-b",
			segmentRequested: true,
			createObservationId: () => "o2",
			createSegmentId: () => "s1",
		});
		expect(second.tree.root?.id).toBe("s1");
		expect(second.data?.segmentCheck).toBe("complete");
	});

	it("promotes valid children when an invalid nested Segment is removed", () => {
		const a = observation("o1", "raw-a");
		const b = observation("o2", "raw-b");
		const root = segment("s1", [a.id, b.id], "Root", "Done.");
		const entries = [source("raw-a"), source("raw-b"), event("initial", [a, b, root], "raw-b"), source("raw-c"), source("raw-d")];
		const ids = ["o3", "o4"];
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
		expect((result.tree.root as Segment).childIds).toEqual([a.id, b.id, "o3", "o4"]);
	});

	it("canonicalizes unordered proposal children from source positions", () => {
		const a = observation("o1", "raw-a");
		const b = observation("o2", "raw-b");
		const root = segment("s1", [a.id, b.id], "Root", "Done.");
		const entries = [source("raw-a"), source("raw-b"), event("initial", [a, b, root], "raw-b"), source("raw-c"), source("raw-d")];
		const ids = ["o4", "o3"];
		const result = applyObserverProposal(new MemoryTreeStore().rebuild(entries), {
			type: "segment", id: root.id, title: root.title, summary: root.summary,
			children: [
				{ type: "observation", content: "The later source recorded a durable result.", sourceEntryIds: ["raw-d"] },
				{ type: "observation", content: "The earlier source recorded a durable decision.", sourceEntryIds: ["raw-c"] },
			],
		}, entries, {
			allowedSourceEntryIds: ["raw-c", "raw-d"], coversUpToId: "raw-d", segmentRequested: true,
			createObservationId: () => ids.shift()!,
		});

		expect(result.warnings).toEqual([]);
		expect(result.data?.segmentCheck).toBe("complete");
		expect((result.tree.root as Segment).childIds).toEqual([a.id, b.id, "o3", "o4"]);
		expect(result.data?.nodeRecords.slice(0, 2).map((record) => record.id)).toEqual(["o3", "o4"]);
	});

	it("preserves existing leaf order when unordered refs share a source position", () => {
		const a = observation("o1", "raw-a", "The shared source established the first durable requirement with enough detail to summarize.");
		const b = observation("o2", "raw-a", "The shared source established the second durable requirement with enough detail to summarize.");
		const root = segment("s1", [a.id, b.id], "Root", "Done.");
		const entries = [source("raw-a"), event("initial", [a, b, root], "raw-a"), source("raw-b")];
		const result = applyObserverProposal(new MemoryTreeStore().rebuild(entries), {
			type: "segment", id: root.id, title: root.title, summary: root.summary,
			children: [
				{ type: "observation", content: "The later source recorded a third durable requirement with enough detail to summarize.", sourceEntryIds: ["raw-b"] },
				{ type: "segment", title: "Shared source", summary: "Two requirements.", children: [
					{ type: "ref", id: b.id }, { type: "ref", id: a.id },
				] },
			],
		}, entries, {
			allowedSourceEntryIds: ["raw-b"], coversUpToId: "raw-b", segmentRequested: true,
			createObservationId: () => "o3", createSegmentId: () => "s2",
		});

		expect(result.warnings).toEqual([]);
		expect(result.tree.segmentsById.get("s2")?.childIds).toEqual([a.id, b.id]);
		expect((result.tree.root as Segment).childIds).toEqual(["s2", "o3"]);
	});

	it("canonicalizes nested Segment and ref siblings while rejecting non-consecutive ranges", () => {
		const a = observation("o1", "raw-a");
		const b = observation("o2", "raw-b");
		const root = segment("s1", [a.id, b.id], "Root", "Done.");
		const entries = [source("raw-a"), source("raw-b"), event("initial", [a, b, root], "raw-b"), source("raw-c"), source("raw-d")];
		const observationIds = ["o4", "o3"];
		const segmentIds = ["s2", "s3"] as const;
		let segmentIndex = 0;
		const result = applyObserverProposal(new MemoryTreeStore().rebuild(entries), {
			type: "segment", id: root.id, title: root.title, summary: root.summary,
			children: [
				{ type: "segment", title: "Later", summary: "Later facts.", children: [
					{ type: "observation", content: "The later source recorded a durable result with enough detail to summarize.", sourceEntryIds: ["raw-d"] },
					{ type: "observation", content: "The earlier source recorded a durable decision with enough detail to summarize.", sourceEntryIds: ["raw-c"] },
				] },
				{ type: "segment", title: "Earlier", summary: "Earlier facts.", children: [
					{ type: "ref", id: b.id },
					{ type: "ref", id: a.id },
				] },
			],
		}, entries, {
			allowedSourceEntryIds: ["raw-c", "raw-d"], coversUpToId: "raw-d", segmentRequested: true,
			createObservationId: () => observationIds.shift()!,
			createSegmentId: () => segmentIds[segmentIndex++]!,
		});

		expect(result.warnings).toEqual([]);
		expect((result.tree.root as Segment).childIds).toEqual(["s3", "s2"]);
		expect(result.tree.segmentsById.get("s3")?.childIds).toEqual([a.id, b.id]);
		expect(result.tree.segmentsById.get("s2")?.childIds).toEqual(["o3", "o4"]);

		const c = observation("o3", "raw-c");
		const threeRoot = segment("s4", [a.id, b.id, c.id], "Root", "Done.");
		const threeEntries = [source("raw-a"), source("raw-b"), source("raw-c"), event("three", [a, b, c, threeRoot], "raw-c")];
		const crossed = applyObserverProposal(new MemoryTreeStore().rebuild(threeEntries), {
			type: "segment", id: threeRoot.id, title: threeRoot.title, summary: threeRoot.summary,
			children: [{ type: "segment", title: "Gap", summary: "Invalid range.", children: [
				{ type: "ref", id: c.id }, { type: "ref", id: a.id },
			] }],
		}, threeEntries, {
			allowedSourceEntryIds: [], segmentRequested: true, createSegmentId: () => "s5",
		});
		expect(crossed.warnings).toContain("rejected non-contiguous Segment replacement for s5");
		expect(crossed.tree.root).toEqual(threeRoot);
	});

	it("falls back to existing Root fields and keeps partial cadence after invalid fields", () => {
		const a = observation("o1", "raw-a");
		const b = observation("o2", "raw-b");
		const root = segment("s1", [a.id, b.id], "Original title", "Done.");
		const entries = [source("raw-a"), source("raw-b"), event("initial", [a, b, root], "raw-b")];
		const result = applyObserverProposal(new MemoryTreeStore().rebuild(entries), {
			type: "segment", id: root.id, title: "bad\ntitle", summary: "bad\nsummary",
			children: [{ type: "ref", id: a.id }, { type: "ref", id: b.id }],
		}, entries, { allowedSourceEntryIds: [], segmentRequested: true });
		expect(result.data?.segmentCheck).toBe("partial");
		expect(result.data?.warnings).toEqual(expect.arrayContaining(["kept existing title for s1", "kept existing summary for s1"]));
		expect(result.tree.root).toMatchObject({ title: root.title, summary: root.summary });
		const replay = new MemoryTreeStore().rebuild([...entries, { ...event("partial", []), data: result.data }]);
		expect(replay.observationBatchesSinceSegmentation).toBe(1);
	});

	it("canonicalizes and de-duplicates proposal source provenance", () => {
		const result = applyObserverProposal(new MemoryTreeStore().rebuild([]), {
			type: "observation", content: "A durable observation with canonical provenance.", sourceEntryIds: ["raw-b", "raw-a", "raw-b"],
		}, [source("raw-a"), source("raw-b")], {
			allowedSourceEntryIds: ["raw-a", "raw-b"], coversUpToId: "raw-b", segmentRequested: false,
			createObservationId: () => "o1",
		});
		expect(result.data?.nodeRecords[0]).toMatchObject({ sourceEntryIds: ["raw-a", "raw-b"] });
	});

	it("rejects strict envelope, newline, and ID violations during replay", () => {
		const a = observation("o1", "raw-a");
		const b = observation("o2", "raw-b");
		const root = segment("s1", [a.id, b.id]);
		const base = [source("raw-a"), source("raw-b"), event("valid", [a, b, root], "raw-b")];
		expect(() => new MemoryTreeStore().rebuild([{ ...base[2], data: { ...(base[2] as any).data, extra: true } }])).toThrow(MemoryTreeError);
		expect(() => new MemoryTreeStore().rebuild([{ ...base[2], data: recorded({ nodeRecords: [{ ...root, summary: "bad\nsummary" }], segmentCheck: "complete" }) }])).toThrow(MemoryTreeError);
		expect(() => new MemoryTreeStore().rebuild([{ ...base[2], data: recorded({ nodeRecords: [{ ...a, id: "AAAAAAAAAAAA" }, b, root], coversUpToId: "raw-b", segmentCheck: "complete" }) }])).toThrow(MemoryTreeError);
	});

	it("does not persist a Root-only ordinary proposal after invalid leaves are removed", () => {
		const a = observation("o1", "raw-a");
		const b = observation("o2", "raw-b");
		const root = segment("s1", [a.id, b.id]);
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
