import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { OBSERVER_SYSTEM } from "../src/agents/observer/prompts.ts";
import { OBSERVER_TOOL_SCHEMA, buildObserverUserPrompt } from "../src/agents/observer/protocol.ts";
import { maxTreeDepth, renderMemoryTree } from "../src/memory-tree/render.ts";
import { getNode } from "../src/memory-tree/node.ts";
import { applyObserverProposal, MemoryTreeStore } from "../src/memory-tree/store.ts";
import { OM_OBSERVATIONS_RECORDED } from "../src/memory-tree/types.ts";

const endpoint = process.env.EVAL_ENDPOINT ?? "https://lyric-openai-qiyin.services.ai.azure.com/openai/v1";
const model = process.env.EVAL_MODEL ?? "gpt-5.6-luna-2";
const reasoning = "medium";
const reportPath = process.env.EVAL_REPORT ?? "/tmp/hierarchy-eval.json";
const outputDir = process.env.EVAL_OUTPUT_DIR;
if (!process.env.API_KEY) process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
const apiKey = process.env.API_KEY;
if (!apiKey) throw new Error("API_KEY is missing after loading .env");

const fixture = JSON.parse(await readFile(new URL("./real-session-hierarchy-cases.json", import.meta.url), "utf8"));
const sessions = JSON.parse(await readFile(new URL("./real-session-hierarchy-observations.json", import.meta.url), "utf8"));
const systemPrompt = process.env.EVAL_PROMPT_FILE
  ? await readFile(process.env.EVAL_PROMPT_FILE, "utf8")
  : OBSERVER_SYSTEM;

function idsForRange(observations, [from, to]) {
  const start = observations.findIndex((item) => item.id === from);
  const end = observations.findIndex((item) => item.id === to);
  if (start < 0 || end < start) throw new Error(`invalid Observation range ${from}..${to}`);
  return observations.slice(start, end + 1).map((item) => item.id);
}

function buildInput(test) {
  const observations = sessions[test.session].observations;
  const byId = new Map(observations.map((item) => [item.id, item]));
  const selected = new Map();
  const segments = new Map();

  function children(specs) {
    return specs.flatMap((spec) => {
      if (spec.range) {
        const ids = idsForRange(observations, spec.range);
        for (const id of ids) {
          const observation = byId.get(id);
          selected.set(id, { ...observation, sourceEntryIds: [`fixture-${test.name}-${observations.findIndex((item) => item.id === id)}`] });
        }
        return ids;
      }
      const specSegment = spec.segment;
      const childIds = children(specSegment.children);
      const segment = { id: specSegment.id, title: specSegment.title, summary: specSegment.summary, childIds };
      segments.set(segment.id, segment);
      return [segment.id];
    });
  }

  const root = {
    id: test.input.rootId,
    title: test.input.title,
    summary: test.input.summary,
    childIds: children(test.input.children),
  };
  segments.set(root.id, root);
  const sourceEntries = [];
  const seenSources = new Set();
  for (const observation of selected.values()) {
    for (const id of observation.sourceEntryIds) {
      if (seenSources.has(id)) continue;
      seenSources.add(id);
      sourceEntries.push({ type: "message", id, message: { role: "user", content: id } });
    }
  }
  const event = {
    type: "custom",
    id: `event-${test.name}`,
    customType: OM_OBSERVATIONS_RECORDED,
    data: {
      version: 1,
      nodeRecords: [...selected.values(), ...segments.values()],
      coversUpToId: sourceEntries.at(-1).id,
      segmentCheck: "complete",
    },
  };
  const entries = [...sourceEntries, event];
  return { entries, tree: new MemoryTreeStore().rebuild(entries), observations };
}

async function callModel(test, tree) {
  const body = {
    model,
    reasoning: { effort: reasoning },
    input: [
      { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
      { role: "user", content: [{ type: "input_text", text: buildObserverUserPrompt({ tree, chunk: "", segmentRequired: true, successfulBatches: 2 }) }] },
    ],
    tools: [{ type: "function", name: "submit_memory_tree", description: "Submit the single recursive Segment Memory Tree increment for this Observer run.", parameters: OBSERVER_TOOL_SCHEMA }],
    tool_choice: { type: "function", name: "submit_memory_tree" },
  };
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(`${endpoint}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${payload?.error?.message ?? JSON.stringify(payload)}`);
      const calls = (payload.output ?? []).filter((item) => item.type === "function_call" && item.name === "submit_memory_tree");
      if (calls.length !== 1) throw new Error(`expected one submit_memory_tree call, got ${calls.length}`);
      return { proposal: JSON.parse(calls[0].arguments ?? "{}").tree ?? null, usage: payload.usage ?? {} };
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw lastError;
}

function descendants(tree, node) {
  if (!("childIds" in node)) return [node.id];
  return node.childIds.flatMap((id) => descendants(tree, getNode(tree, id)));
}

function includesTerms(text, terms) {
  const lower = text.toLowerCase();
  return terms.filter((term) => !lower.includes(term.toLowerCase()));
}

function evaluate(test, base, normalized) {
  const failures = [];
  const checks = [];
  const check = (condition, failure) => {
    checks.push(condition);
    if (!condition) failures.push(failure);
  };
  const tree = normalized.tree;
  const root = tree.root;
  check(normalized.warnings.length === 0, `normalization warnings: ${normalized.warnings.join("; ")}`);
  check(root?.id === test.input.rootId, `Root id changed to ${root?.id ?? "none"}`);
  check(root && "childIds" in root, "Root is not a Segment");
  if (!root || !("childIds" in root)) return { failures, checks };

  const expectedLeaves = [...base.tree.observationsById.keys()];
  const actualLeaves = [...tree.observationsById.keys()];
  check(expectedLeaves.length === actualLeaves.length && expectedLeaves.every((id) => tree.observationsById.has(id)), "Observation leaf set changed");
  const missingTitle = includesTerms(root.title, test.expect.rootTitleTerms);
  check(missingTitle.length === 0, `Root title missing: ${missingTitle.join(", ")}`);
  const missingRootSummary = includesTerms(root.summary, test.expect.rootSummaryTerms);
  check(missingRootSummary.length === 0, `Root summary missing: ${missingRootSummary.join(", ")}`);
  check(root.summary.length >= test.expect.minRootSummaryChars, `Root summary too short: ${root.summary.length} < ${test.expect.minRootSummaryChars}`);
  check(root.childIds.length <= test.expect.maxRootChildren, `Root has ${root.childIds.length} children > ${test.expect.maxRootChildren}`);
  const rootObservations = root.childIds.filter((id) => tree.observationsById.has(id)).length;
  check(rootObservations <= test.expect.maxRootObservations, `Root has ${rootObservations} direct Observations > ${test.expect.maxRootObservations}`);
  check(maxTreeDepth(tree) >= test.expect.minDepth, `tree depth ${maxTreeDepth(tree)} < ${test.expect.minDepth}`);

  for (const expected of test.expect.segments) {
    const ids = idsForRange(base.observations, expected.range);
    const segment = [...tree.segmentsById.values()].find((item) => item.id !== root.id && JSON.stringify(descendants(tree, item)) === JSON.stringify(ids));
    check(Boolean(segment), `missing exact Segment ${expected.range.join("..")}`);
    if (!segment) continue;
    const missing = includesTerms(segment.summary, expected.summaryTerms);
    check(missing.length === 0, `Segment ${segment.title} summary missing: ${missing.join(", ")}`);
    check(segment.summary.length >= expected.minSummaryChars, `Segment ${segment.title} summary too short: ${segment.summary.length} < ${expected.minSummaryChars}`);
  }
  return { failures, checks };
}

async function run(test) {
  const base = buildInput(test);
  const response = await callModel(test, base.tree);
  let counter = 0;
  const normalized = applyObserverProposal(base.tree, response.proposal, base.entries, {
    allowedSourceEntryIds: [],
    segmentRequested: true,
    createSegmentId: () => `s_${createHash("sha256").update(`${test.name}:${counter++}`).digest("hex").slice(0, 12)}`,
  });
  const evaluation = evaluate(test, base, normalized);
  if (outputDir) {
    await mkdir(outputDir, { recursive: true });
    await writeFile(`${outputDir}/${test.name}.md`, renderMemoryTree(normalized.tree, maxTreeDepth(normalized.tree)).markdown, "utf8");
  }
  return {
    name: test.name,
    passed: evaluation.failures.length === 0,
    checksPassed: evaluation.checks.filter(Boolean).length,
    checksTotal: evaluation.checks.length,
    failures: evaluation.failures,
    warnings: normalized.warnings,
    metrics: {
      observations: normalized.tree.observationsById.size,
      segments: normalized.tree.segmentsById.size,
      depth: maxTreeDepth(normalized.tree),
      rootChildren: "childIds" in normalized.tree.root ? normalized.tree.root.childIds.length : 0,
      rootTitle: normalized.tree.root?.title,
      rootSummaryChars: normalized.tree.root?.summary?.length,
    },
    usage: response.usage,
    proposal: response.proposal,
  };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

if (process.env.EVAL_VALIDATE_ONLY === "1") {
  for (const test of fixture.cases) {
    try { buildInput(test); } catch (error) { throw new Error(`${test.name}: ${error.message}`, { cause: error }); }
  }
  console.log(JSON.stringify({ validatedCases: fixture.cases.length }, null, 2));
  process.exit(0);
}

const results = await mapLimit(fixture.cases, 3, async (test) => {
  console.error(`Evaluating ${test.name}...`);
  try {
    return await run(test);
  } catch (error) {
    return { name: test.name, passed: false, checksPassed: 0, checksTotal: 1, failures: [String(error?.stack ?? error)] };
  }
});
const report = {
  model,
  reasoning,
  prompt: process.env.EVAL_PROMPT_FILE ?? "production",
  casesPassed: results.filter((item) => item.passed).length,
  casesTotal: results.length,
  checksPassed: results.reduce((sum, item) => sum + item.checksPassed, 0),
  checksTotal: results.reduce((sum, item) => sum + item.checksTotal, 0),
  results,
};
await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({ cases: `${report.casesPassed}/${report.casesTotal}`, checks: `${report.checksPassed}/${report.checksTotal}`, reportPath }, null, 2));
process.exitCode = report.casesPassed === report.casesTotal ? 0 : 1;
