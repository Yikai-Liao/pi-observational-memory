import { describe, expect, it } from "vitest";
import { renderMemoryTree } from "../src/memory-tree/render.js";
import type { MemoryTree, Observation, Segment } from "../src/memory-tree/types.js";

const a: Observation = { id: "aaaaaaaaaaaa", content: "Investigated the release workflow and located the faulty routing behavior.", sourceEntryIds: ["raw-a"] };
const b: Observation = { id: "bbbbbbbbbbbb", content: "Corrected the workflow routing and verified the release candidate output.", sourceEntryIds: ["raw-b"] };
const c: Observation = { id: "cccccccccccc", content: "Documented the final architecture requirement for deterministic rendering.", sourceEntryIds: ["raw-c"] };
const child: Segment = { id: "s_222222222222", title: "Release repair", summary: "Fixed and verified release routing.", childIds: [a.id, b.id] };
const root: Segment = { id: "s_111111111111", title: "Release and architecture", summary: "Repaired release automation and finalized the memory design.", childIds: [child.id, c.id] };
const tree: MemoryTree = {
	observationsById: new Map([[a.id, a], [b.id, b], [c.id, c]]),
	segmentsById: new Map([[root.id, root], [child.id, child]]),
	root,
	parentByChildId: new Map([[child.id, root.id], [c.id, root.id], [a.id, child.id], [b.id, child.id]]),
	observationBatchesSinceSegmentation: 0,
	diagnostics: [],
};

describe("renderMemoryTree", () => {
	it("renders every visited Segment before direct observations and child Segments", () => {
		const rendered = renderMemoryTree(tree, 2);
		expect(rendered.markdown).toContain("# [s_111111111111] Release and architecture");
		expect(rendered.markdown).toContain("1. [cccccccccccc] Documented the final architecture");
		expect(rendered.markdown).toContain("## [s_222222222222] Release repair");
		expect(rendered.markdown).toContain("1. [aaaaaaaaaaaa] Investigated the release workflow");
		expect(rendered.markdown).toContain("2. [bbbbbbbbbbbb] Corrected the workflow routing");
		expect(rendered.details.renderedNodeIds).toEqual([root.id, c.id, child.id, a.id, b.id]);
	});

	it("stops only recursion at the configured depth", () => {
		const zero = renderMemoryTree(tree, 0);
		expect(zero.details.renderedNodeIds).toEqual([root.id]);
		expect(zero.markdown).not.toContain(child.id);
		const one = renderMemoryTree(tree, 1);
		expect(one.details.renderedNodeIds).toEqual([root.id, c.id, child.id]);
		expect(one.markdown).toContain(child.summary);
		expect(one.markdown).not.toContain(a.id);
	});

	it("renders a single Observation root consistently at every depth", () => {
		const single: MemoryTree = { ...tree, observationsById: new Map([[a.id, a]]), segmentsById: new Map(), root: a, parentByChildId: new Map() };
		const rendered = renderMemoryTree(single, 3);
		expect(rendered.markdown).toContain("# Memory\n\n1. [aaaaaaaaaaaa]");
		expect(rendered.details.renderedNodeIds).toEqual([a.id]);
	});
});
