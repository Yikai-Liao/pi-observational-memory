import { allocationFor } from "./fixtures/node-records.js";
import { describe, expect, it } from "vitest";
import { renderMemoryTree, maxTreeDepth } from "../src/memory-tree/render.js";
import type { MemoryTree, Observation, Segment } from "../src/memory-tree/types.js";

const a: Observation = { id: "o1", content: "Investigated the release workflow and located the faulty routing behavior.", sourceEntryIds: ["raw-a"] };
const b: Observation = { id: "o2", content: "Corrected the workflow routing and verified the release candidate output.", sourceEntryIds: ["raw-b"] };
const c: Observation = { id: "o3", content: "Documented the final architecture requirement for deterministic rendering.", sourceEntryIds: ["raw-c"] };
const child: Segment = { id: "s2", title: "Release repair", summary: "Fixed and verified release routing.", childIds: [a.id, b.id] };
const root: Segment = { id: "s1", title: "Release and architecture", summary: "Repaired release automation and finalized the memory design.", childIds: [child.id, c.id] };
const tree: MemoryTree = {
	allocation: allocationFor([a, b, c, child, root]),
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
		expect(rendered.markdown).toContain("# Release and architecture");
		expect(rendered.markdown).toContain("1. [o3] Documented the final architecture");
		expect(rendered.markdown).toContain("## Release repair");
		expect(rendered.markdown).toContain("1. [o1] Investigated the release workflow");
		expect(rendered.markdown).toContain("2. [o2] Corrected the workflow routing");
		expect(rendered.details.renderedNodeIds).toEqual([root.id, child.id, a.id, b.id, c.id]);
		expect(rendered.details.exposedRefs).toEqual(["o1", "o2", "o3"]);
		expect(rendered.markdown).not.toMatch(/\[s[0-9]+\]/);
	});

	it("stops only recursion at the configured depth", () => {
		const zero = renderMemoryTree(tree, 0);
		expect(zero.details.renderedNodeIds).toEqual([root.id]);
		expect(zero.details.exposedRefs).toEqual(["s1"]);
		expect(zero.markdown).toContain("# [s1] Release and architecture");
		expect(zero.markdown).not.toContain(child.id);
		const one = renderMemoryTree(tree, 1);
		expect(one.details.renderedNodeIds).toEqual([root.id, child.id, c.id]);
		expect(one.details.exposedRefs).toEqual(["s2", "o3"]);
		expect(one.markdown).not.toContain("[s1]");
		expect(one.markdown).toContain("## [s2] Release repair");
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
		expect(markdown).toContain("\n\n# Release and architecture\n\n");
		expect(markdown.indexOf("## Release repair")).toBeLessThan(markdown.indexOf("1. [o3]"));
		expect(markdown).toContain("\n\n1. [o1]");
		expect(markdown).toContain("\n2. [o2]");
	});

	it("renders a single Observation root consistently at every depth", () => {
		const single: MemoryTree = { ...tree, observationsById: new Map([[a.id, a]]), segmentsById: new Map(), root: a, parentByChildId: new Map() };
		const rendered = renderMemoryTree(single, 3);
		expect(rendered.markdown).toContain("# Memory\n\n1. [o1]");
		expect(rendered.details.renderedNodeIds).toEqual([a.id]);
		expect(rendered.details.exposedRefs).toEqual(["o1"]);
	});

	it("renders empty trees without exposing references", () => {
		const rendered = renderMemoryTree({ ...tree, root: undefined }, 0);
		expect(rendered.markdown).toBe("");
		expect(rendered.details).toMatchObject({ version: 2, renderedNodeIds: [], exposedRefs: [] });
	});
});
