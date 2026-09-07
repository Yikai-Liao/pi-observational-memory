import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { OBSERVER_SYSTEM } from "../src/agents/observer/prompts.ts";
import { OBSERVER_TOOL_SCHEMA, buildObserverUserPrompt } from "../src/agents/observer/protocol.ts";
import { applyObserverProposal } from "../src/memory-tree/store.ts";
import { estimateStringTokens } from "../src/tokens.ts";
import { checkObservationMeaning } from "./observer-semantic-check.mjs";

const endpoint = process.env.EVAL_ENDPOINT;
const model = process.env.EVAL_MODEL;
const apiKey = process.env.API_KEY;
const reasoning = process.env.EVAL_REASONING;
const reportPath = process.env.EVAL_REPORT;
if (!endpoint || !model || !apiKey || !reasoning) {
	throw new Error("Set EVAL_ENDPOINT, EVAL_MODEL, EVAL_REASONING, and API_KEY");
}

const cases = JSON.parse(await readFile(new URL("./observer-cases.json", import.meta.url), "utf8"));

function buildTree(input) {
	const observationsById = new Map(input.observations.map((node) => [node.id, node]));
	const segmentsById = new Map(input.segments.map((node) => [node.id, node]));
	const root = input.rootId ? observationsById.get(input.rootId) ?? segmentsById.get(input.rootId) : undefined;
	return { observationsById, segmentsById, root, parentByChildId: new Map(), observationBatchesSinceSegmentation: 0, diagnostics: [] };
}

function sourceIds(test) {
	const old = test.tree.observations.flatMap((item) => item.sourceEntryIds);
	const current = [...test.source.matchAll(/\[Source entry id: ([^\]]+)\]/g)].map((match) => match[1]);
	return { old, current, entries: [...old, ...current].map((id) => ({ type: "message", id, message: { role: "user", content: id } })) };
}

function nodeSelfTokens(node) {
	return estimateStringTokens("content" in node
		? `[${node.id}] ${node.content}`
		: `[${node.id}] ${node.title}\n\n${node.summary}`);
}

function expandingSegments(tree) {
	return [...tree.segmentsById.values()].filter((segment) => {
		const children = segment.childIds.reduce((total, id) => {
			const child = tree.observationsById.get(id) ?? tree.segmentsById.get(id);
			return total + (child ? nodeSelfTokens(child) : 0);
		}, 0);
		return nodeSelfTokens(segment) >= children;
	});
}

function nodes(proposal) {
	const result = [];
	const walk = (node, depth = 0) => {
		if (!node || typeof node !== "object") return;
		result.push({ node, depth });
		if (node.type === "segment" && Array.isArray(node.children)) node.children.forEach((child) => walk(child, depth + 1));
	};
	walk(proposal);
	return result;
}

function validate(test, response) {
	const failures = [];
	const calls = (response?.output ?? []).filter((item) => item.type === "function_call");
	if (calls.length !== 1) failures.push(`expected exactly one tool call, got ${calls.length}`);
	if (calls[0]?.name !== "submit_memory_tree") failures.push(`unexpected tool ${calls[0]?.name ?? "none"}`);
	let parsed;
	try { parsed = JSON.parse(calls[0]?.arguments ?? ""); } catch { failures.push("tool arguments are not valid JSON"); }
	const proposal = parsed?.tree;
	const expectedType = test.expect.topType;
	if (expectedType === "null") {
		if (proposal !== null) failures.push("expected tree=null");
		return { failures, proposal, raw: response };
	}
	if (test.expect.topTypes ? !test.expect.topTypes.includes(proposal?.type) : proposal?.type !== expectedType) {
		failures.push(`expected top type ${test.expect.topTypes?.join(" or ") ?? expectedType}, got ${proposal?.type ?? "null"}`);
	}
	if (!proposal) return { failures, proposal, raw: response };
	if (test.expect.rootId === null && proposal.id !== undefined) failures.push(`new Root must not carry id ${proposal.id}`);
	if (typeof test.expect.rootId === "string" && proposal.id !== test.expect.rootId) failures.push(`expected stable Root id ${test.expect.rootId}, got ${proposal.id}`);

	const all = nodes(proposal);
	const refs = all.filter(({ node }) => node.type === "ref").map(({ node }) => node.id);
	const observations = all.filter(({ node }) => node.type === "observation").map(({ node }) => node);
	const segments = all.filter(({ node }) => node.type === "segment");
	for (const { node, depth } of segments) {
		if (!Array.isArray(node.children)) failures.push("Segment children missing");
		if (depth > 0 && node.children?.length < 2) failures.push("new nested Segment has fewer than two children");
		if (depth > 0 && node.id !== undefined) failures.push(`new nested Segment illegally carries id ${node.id}`);
		if (/\r|\n/.test(node.title ?? "") || /\r|\n/.test(node.summary ?? "")) failures.push("Segment title/summary contains a newline");
	}
	for (const observation of observations) {
		if (observation.id !== undefined) failures.push(`new Observation illegally carries id ${observation.id}`);
		if (/\r|\n/.test(observation.content ?? "")) failures.push("Observation content contains a newline");
		if (!Array.isArray(observation.sourceEntryIds) || observation.sourceEntryIds.length === 0) failures.push("Observation lacks sourceEntryIds");
		else if (new Set(observation.sourceEntryIds).size !== observation.sourceEntryIds.length) failures.push("Observation contains duplicate sourceEntryIds");
	}
	const duplicateRefs = refs.filter((id, index) => refs.indexOf(id) !== index);
	if (duplicateRefs.length) failures.push(`duplicate refs: ${[...new Set(duplicateRefs)].join(", ")}`);

	const actualSources = [...new Set(observations.flatMap((node) => node.sourceEntryIds ?? []))];
	if (test.expect.sourceIds && JSON.stringify(actualSources) !== JSON.stringify(test.expect.sourceIds)) failures.push(`expected source IDs ${test.expect.sourceIds}, got ${actualSources}`);
	for (const id of test.expect.sourceIdsInclude ?? []) if (!actualSources.includes(id)) failures.push(`missing required source ID ${id}`);
	const allowedSources = new Set(test.expect.allowedSourceIds ?? [...test.source.matchAll(/\[Source entry id: ([^\]]+)\]/g)].map((match) => match[1]));
	for (const source of actualSources) if (!allowedSources.has(source)) failures.push(`invented source ID ${source}`);
	if (test.expect.newObservationCount !== undefined && observations.length !== test.expect.newObservationCount) failures.push(`expected ${test.expect.newObservationCount} new Observations, got ${observations.length}`);
	for (const id of test.expect.refIds ?? []) if (!refs.includes(id)) failures.push(`missing ref ${id}`);
	for (const id of test.expect.forbidRefIds ?? []) if (refs.includes(id)) failures.push(`forbidden hidden-descendant ref ${id}`);
	const text = observations.map((node) => node.content).join(" ");
	const observationEstimatedTokens = observations.reduce((total, node) => total + estimateStringTokens(node.content ?? ""), 0);
	if (test.expect.maxObservationEstimatedTokens !== undefined && observationEstimatedTokens > test.expect.maxObservationEstimatedTokens) {
		failures.push(`Observation verbosity: estimated ${observationEstimatedTokens} tokens exceeds ${test.expect.maxObservationEstimatedTokens}`);
	}
	for (const term of test.expect.contentTerms ?? []) if (!text.toLowerCase().includes(term.toLowerCase())) failures.push(`Observation content missing ${term}`);
	for (const pattern of test.expect.forbiddenContentPatterns ?? []) if (new RegExp(pattern, "i").test(text)) failures.push(`Observation content matches forbidden polarity ${pattern}`);
	const nested = segments.filter(({ depth }) => depth > 0);
	if (test.expect.nestedSegment === true && nested.length === 0) failures.push("expected a nested Segment");
	if (test.expect.nestedSegment === false && nested.length > 0) failures.push("unexpected nested Segment");
	if (test.expect.groupedRefIds) {
		const group = nested.find(({ node }) => {
			const nestedRefs = nodes(node).filter(({ node: child }) => child.type === "ref").map(({ node: child }) => child.id);
			return test.expect.groupedRefIds.every((id) => nestedRefs.includes(id));
		});
		if (!group) failures.push(`expected one nested Segment grouping ${test.expect.groupedRefIds.join(", ")}`);
		else for (const term of test.expect.summaryTerms ?? []) if (!group.node.summary.toLowerCase().includes(term.toLowerCase())) failures.push(`group summary missing ${term}`);
	}
	for (const id of test.expect.ungroupedRefIds ?? []) {
		if (!proposal.children?.some((child) => child.type === "ref" && child.id === id)) failures.push(`expected direct ungrouped ref ${id}`);
	}
	return { failures, proposal, raw: response };
}

async function post(body) {
	try {
		return await fetch(`${endpoint.replace(/\/$/, "")}/responses`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
	} catch {
		return fetch(`${endpoint.replace(/\/$/, "")}/responses`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
	}
}

async function run(test) {
	const body = {
		model,
		reasoning: { effort: reasoning },
		input: [
			{ role: "system", content: [{ type: "input_text", text: OBSERVER_SYSTEM }] },
			{ role: "user", content: [{ type: "input_text", text: buildObserverUserPrompt({ tree: buildTree(test.tree), chunk: test.source, segmentRequired: test.segmentRequired, successfulBatches: test.successfulBatches }) }] },
		],
		tools: [{ type: "function", name: "submit_memory_tree", description: "Submit the single recursive Segment Memory Tree increment for this Observer run.", parameters: OBSERVER_TOOL_SCHEMA }],
		tool_choice: { type: "function", name: "submit_memory_tree" },
	};
	const response = await post(body);
	const payload = await response.json();
	if (!response.ok) return { name: test.name, passed: false, failures: [`HTTP ${response.status}: ${payload.error?.message ?? JSON.stringify(payload)}`] };
	const checked = validate(test, payload);
	if (checked.failures.length === 0 && (checked.proposal !== null || test.tree.rootId)) {
		const sources = sourceIds(test);
		const normalized = applyObserverProposal(buildTree(test.tree), checked.proposal, sources.entries, {
			allowedSourceEntryIds: sources.current,
			coversUpToId: sources.current.at(-1),
			segmentRequested: test.segmentRequired,
		});
		if (checked.proposal !== null && !normalized.data) checked.failures.push("production normalizer rejected the proposal");
		checked.failures.push(...normalized.warnings.map((warning) => `production warning: ${warning}`));
		for (const segment of expandingSegments(normalized.tree)) {
			checked.failures.push(`prompt compression regression: Segment ${segment.id} is not smaller than its direct children`);
		}
	}
	if (checked.failures.length === 0 && test.expect.semanticRequirements) {
		try {
			const grade = (content) => checkObservationMeaning({
				source: test.source,
				content,
				requirements: test.expect.semanticRequirements,
				request: async (input) => {
					const response = await post({ model, reasoning: { effort: reasoning }, ...input });
					if (!response.ok) throw new Error(`semantic grader HTTP ${response.status}`);
					return response.json();
				},
			});
			// Calibrate on omissions and valid paraphrases, independently of the
			// generated answer. An unreliable grader fails the eval, never passes it.
			for (const [index, probe] of (test.expect.semanticProbes ?? []).entries()) {
				const checks = await grade(probe.content);
				if (checks.some((check) => check.passed !== !probe.missing.includes(check.id))) {
					checked.failures.push(`semantic grader calibration failed for probe ${index + 1}`);
				}
			}
			if (checked.failures.length === 0) {
				const content = nodes(checked.proposal).filter(({ node }) => node.type === "observation").map(({ node }) => node.content).join("\n");
				for (const check of await grade(content)) {
					if (!check.passed) checked.failures.push(`Observation meaning missing ${check.id}: ${check.reason}`);
				}
			}
		} catch (error) {
			checked.failures.push(`semantic grading failed: ${error.message}`);
		}
	}
	const all = nodes(checked.proposal);
	// Local prose-size estimates, not provider usage or serialized tool-call size.
	const observationEstimatedTokens = all.filter(({ node }) => node.type === "observation")
		.reduce((total, { node }) => total + estimateStringTokens(node.content ?? ""), 0);
	const segmentEstimatedTokens = all.filter(({ node }) => node.type === "segment")
		.reduce((total, { node }) => total + estimateStringTokens(`${node.title ?? ""}\n\n${node.summary ?? ""}`), 0);
	return { name: test.name, passed: checked.failures.length === 0, failures: checked.failures, observationEstimatedTokens, segmentEstimatedTokens, proposal: checked.proposal };
}

const results = await Promise.all(cases.map(run));
const passed = results.filter((result) => result.passed).length;
const report = { model, reasoning, passed, total: results.length, score: passed / results.length * 100, results };
const serialized = JSON.stringify(report, null, 2);
if (reportPath) await writeFile(resolve(reportPath), serialized);
console.log(serialized);
if (passed !== results.length) process.exitCode = 1;
