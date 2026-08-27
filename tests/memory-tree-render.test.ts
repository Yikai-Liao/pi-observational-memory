import { describe, expect, it } from "vitest";
import { renderMemoryTree, maxTreeDepth } from "../src/memory-tree/render.js";
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
	it("renders mixed children in canonical source order", () => {
		const rendered = renderMemoryTree(tree, 2);
		expect(rendered.markdown).toContain("# [s_111111111111] Release and architecture");
		expect(rendered.markdown).toContain("1. [cccccccccccc] Documented the final architecture");
		expect(rendered.markdown).toContain("## [s_222222222222] Release repair");
		expect(rendered.markdown).toContain("1. [aaaaaaaaaaaa] Investigated the release workflow");
		expect(rendered.markdown).toContain("2. [bbbbbbbbbbbb] Corrected the workflow routing");
		expect(rendered.details.renderedNodeIds).toEqual([root.id, child.id, a.id, b.id, c.id]);
	});

	it("stops only recursion at the configured depth", () => {
		const zero = renderMemoryTree(tree, 0);
		expect(zero.details.renderedNodeIds).toEqual([root.id]);
		expect(zero.markdown).not.toContain(child.id);
		const one = renderMemoryTree(tree, 1);
		expect(one.details.renderedNodeIds).toEqual([root.id, child.id, c.id]);
		expect(one.markdown).toContain(child.summary);
		expect(one.markdown).not.toContain(a.id);
	});

	it("reports token cost, maximum depth, and rejects invalid depths", () => {
		const rendered = renderMemoryTree(tree, 2);
		expect(rendered.estimatedTokens).toBe(Math.ceil(rendered.markdown.length / 4));
		expect(maxTreeDepth(tree)).toBe(2);
		expect(() => renderMemoryTree(tree, -1)).toThrow(/memoryDepth/);
		expect(() => renderMemoryTree(tree, 1.5)).toThrow(/memoryDepth/);
	});

	it("keeps the compaction Markdown structure and section boundaries", () => {
		const markdown = renderMemoryTree(tree, 2).markdown;
		expect(markdown).toMatch(/^These are your past working memories, organized as a Segment Tree\./);
		expect(markdown).toContain("\n\n# [s_111111111111] Release and architecture\n\n");
		expect(markdown.indexOf("## [s_222222222222]")).toBeLessThan(markdown.indexOf("1. [cccccccccccc]"));
		expect(markdown).toContain("\n\n1. [aaaaaaaaaaaa]");
		expect(markdown).toContain("\n2. [bbbbbbbbbbbb]");
	});

	it("renders a single Observation root consistently at every depth", () => {
		const single: MemoryTree = { ...tree, observationsById: new Map([[a.id, a]]), segmentsById: new Map(), root: a, parentByChildId: new Map() };
		const rendered = renderMemoryTree(single, 3);
		expect(rendered.markdown).toContain("# Memory\n\n1. [aaaaaaaaaaaa]");
		expect(rendered.details.renderedNodeIds).toEqual([a.id]);
	});
});
