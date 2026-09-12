/**
 * Real-session V4 hierarchy evaluation with frozen V3 Observation leaves.
 *
 *   node eval/run-real-session-v4-eval.mts --canary
 *   node eval/run-real-session-v4-eval.mts
 *
 * Loads API_KEY from the process environment, then project .env if absent.
 * Set REAL_SESSION_EVAL_OUTPUT, EVAL_ENDPOINT, or EVAL_MODEL to override defaults.
 */
import { fixtureAllocation } from "./node-id-fixtures.mjs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { OBSERVER_SYSTEM } from "../src/agents/observer/prompts.ts";
import { OBSERVER_TOOL_SCHEMA, buildObserverUserPrompt } from "../src/agents/observer/protocol.ts";
import { applyObserverProposal } from "../src/memory-tree/store.ts";
import { maxTreeDepth, renderMemoryTree } from "../src/memory-tree/render.ts";
import { isSourceEntry } from "../src/progress.ts";
import { serializeSourceAddressedBranchEntries } from "../src/serialize.ts";
import { estimateStringTokens } from "../src/tokens.ts";
import type { Entry, MemoryTree, Node, NodeProposal, Observation, Segment } from "../src/memory-tree/types.ts";

const CANARY = process.argv.includes("--canary");
const OUTPUT_ROOT = process.env.REAL_SESSION_EVAL_OUTPUT ?? join(homedir(), CANARY ? "v4-real-session-eval-canary" : "v4-real-session-eval");
const ENDPOINT = process.env.EVAL_ENDPOINT ?? "https://lyric-openai-qiyin.services.ai.azure.com/openai/v1";
const MODEL = process.env.EVAL_MODEL ?? "gpt-5.6-luna-2";
const SYSTEM_PROMPT = process.env.EVAL_PROMPT_FILE ? await readFile(process.env.EVAL_PROMPT_FILE, "utf8") : OBSERVER_SYSTEM;
const TRACE_NORMALIZATION = process.env.EVAL_TRACE_NORMALIZATION === "1";
const MAX_ROUNDS = 6;
type Selection = { id: string; label: string; activeObservationIds: string[]; droppedObservationIds: string[] };
const SELECTIONS = (JSON.parse(await readFile(new URL("./real-session-v3-selection.json", import.meta.url), "utf8")) as { sessions: Selection[] }).sessions;
const SESSION_IDS = SELECTIONS.map((item) => item.id);
const ALL_LEVELS = ["low", "medium", "high"] as const;
type Level = typeof ALL_LEVELS[number];
const LEVELS = (CANARY ? ["medium"] : (process.env.EVAL_LEVELS?.split(",") ?? ALL_LEVELS)) as Level[];
if (LEVELS.some((level) => !ALL_LEVELS.includes(level))) throw new Error(`Invalid EVAL_LEVELS: ${LEVELS.join(",")}`);
const ALL_MODES = ["progressive", "posthoc-single", "posthoc-iterative", "raw-v4"] as const;
type Mode = typeof ALL_MODES[number];
const MODES = (process.env.EVAL_MODES?.split(",") ?? ALL_MODES) as Mode[];
if (MODES.some((mode) => !ALL_MODES.includes(mode))) throw new Error(`Invalid EVAL_MODES: ${MODES.join(",")}`);
type V3Observation = Observation & { timestamp?: string; relevance?: string; tokenCount?: number };
type Prepared = {
  info: any;
  branch: Entry[];
  allObservations: V3Observation[];
  activeObservations: V3Observation[];
  activeBatches: V3Observation[][];
  sourceBatches: Entry[][];
  droppedObservationIds: Set<string>;
  dir: string;
  seed: MemoryTree;
};
type TreeSnapshot = {
  rootId?: string;
  observationBatchesSinceSegmentation: number;
  observations: Observation[];
  segments: Segment[];
};
type NormalizationTrace = {
  call: number;
  segmentRequired: boolean;
  successfulBatches: number;
  sourceLedgerIds: string[];
  allowedSourceEntryIds: string[];
  chunk: string;
  before: TreeSnapshot;
  proposal: NodeProposal | null;
  warnings: string[];
  after: TreeSnapshot;
};
type Generated = {
  prepared: Prepared;
  level: Level;
  mode: Mode;
  tree: MemoryTree;
  rounds: number;
  warnings: string[];
  usage: { inputTokens: number; outputTokens: number };
  normalizationTraces?: NormalizationTrace[];
};

function snapshotTree(tree: MemoryTree): TreeSnapshot {
  return {
    ...(tree.root ? { rootId: tree.root.id } : {}),
    observationBatchesSinceSegmentation: tree.observationBatchesSinceSegmentation,
    observations: [...tree.observationsById.values()],
    segments: [...tree.segmentsById.values()],
  };
}

function singleLine(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function fenced(value: string, language = "text"): string {
  const runs = [...value.matchAll(/`+/g)].map((match) => match[0].length);
  const ticks = "`".repeat(Math.max(3, (runs.length ? Math.max(...runs) : 0) + 1));
  return `${ticks}${language}\n${value}\n${ticks}`;
}

function contentText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content, null, 2);
  return content.map((block) => {
    if (block?.type === "text") return block.text ?? "";
    if (block?.type === "thinking") return `<details><summary>Assistant thinking</summary>\n\n${fenced(block.thinking ?? "")}\n\n</details>`;
    if (block?.type === "toolCall") return `**Tool call: ${block.name}**\n\n${fenced(JSON.stringify(block.arguments ?? {}, null, 2), "json")}`;
    if (block?.type === "image") return `[image omitted from Markdown: ${block.mimeType ?? block.mediaType ?? "unknown type"}, ${String(block.data ?? "").length} base64 characters]`;
    return fenced(JSON.stringify(block, null, 2), "json");
  }).filter(Boolean).join("\n\n");
}

function sourceMarkdown(prepared: Prepared): string {
  const lines = [
    `# Original conversation — ${prepared.info.id}`,
    "",
    `- Session ID: \`${prepared.info.id}\``,
    `- Working directory: \`${prepared.info.cwd}\``,
    `- Session file: \`${prepared.info.path}\``,
    `- Active branch entries: ${prepared.branch.length}`,
    "- Binary image payloads are represented by placeholders; all textual message, thinking, tool-call, and tool-result content is retained.",
    "",
  ];
  let ordinal = 0;
  for (const entry of prepared.branch as any[]) {
    if (entry.type === "custom" && ["om.observations.recorded", "om.reflections.recorded", "om.observations.dropped"].includes(entry.customType)) continue;
    ordinal++;
    lines.push(`## ${ordinal}. ${entry.type} — ${entry.id}`, "", `- Timestamp: ${entry.timestamp ?? "unknown"}`, `- Parent: ${entry.parentId ?? "none"}`, "");
    if (entry.type === "message") {
      const message = entry.message ?? {};
      lines.push(`**Role: ${message.role ?? "unknown"}**`, "");
      if (message.role === "assistant") {
        lines.push(`- Provider/model: ${message.provider ?? "unknown"}/${message.model ?? "unknown"}`);
        lines.push(`- Stop reason: ${message.stopReason ?? "unknown"}`, "");
      } else if (message.role === "toolResult") {
        lines.push(`- Tool: ${message.toolName ?? "unknown"}`);
        lines.push(`- Error: ${message.isError === true ? "yes" : "no"}`, "");
      }
      lines.push(contentText(message.content) || "_(empty content)_", "");
      continue;
    }
    if (entry.type === "custom_message") {
      lines.push(`**Custom message: ${entry.customType ?? "unknown"}**`, "", contentText(entry.content) || "_(empty content)_", "");
      continue;
    }
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      lines.push(entry.summary ?? "_(empty summary)_", "");
      continue;
    }
    const metadata = Object.fromEntries(Object.entries(entry).filter(([key]) => !["type", "id", "parentId", "timestamp"].includes(key)));
    lines.push(fenced(JSON.stringify(metadata, null, 2), "json"), "");
  }
  return lines.join("\n");
}

function v3Markdown(prepared: Prepared): string {
  const activeIds = new Set(prepared.activeObservations.map((item) => item.id));
  const dropped = prepared.allObservations.filter((item) => prepared.droppedObservationIds.has(item.id));
  const unknownDropped = [...prepared.droppedObservationIds].filter((id) => !prepared.allObservations.some((item) => item.id === id));
  const lines = [
    `# V3 flat Observations — ${prepared.info.id}`,
    "",
    `- Active Observations: ${prepared.activeObservations.length}`,
    `- Dropped recorded Observations: ${dropped.length}`,
    `- Drop tombstones without a folded record: ${unknownDropped.length}`,
    "- Fold semantics: first valid record wins; Dropper entries act as tombstones.",
    "",
    "## Active Observations",
    "",
  ];
  prepared.allObservations.filter((item) => activeIds.has(item.id)).forEach((item, index) => {
    lines.push(`${index + 1}. **[${item.id}] ${item.timestamp ?? "unknown"} [${item.relevance ?? "unknown"}]** ${singleLine(item.content)}`);
    lines.push(`   - Sources: ${item.sourceEntryIds.map((id) => `\`${id}\``).join(", ")}`);
  });
  lines.push("", "## Dropped Observations appendix", "");
  if (dropped.length === 0) lines.push("_(none)_");
  dropped.forEach((item, index) => {
    lines.push(`${index + 1}. **[${item.id}] ${item.timestamp ?? "unknown"} [${item.relevance ?? "unknown"}]** ${singleLine(item.content)}`);
    lines.push(`   - Sources: ${item.sourceEntryIds.map((id) => `\`${id}\``).join(", ")}`);
  });
  if (unknownDropped.length > 0) lines.push("", "### Tombstones without folded records", "", ...unknownDropped.map((id) => `- \`${id}\``));
  return lines.join("\n");
}

function foldV3(branch: Entry[]): { all: V3Observation[]; active: V3Observation[]; batches: V3Observation[][]; dropped: Set<string> } {
  const observations = new Map<string, V3Observation>();
  const recordedBatches: V3Observation[][] = [];
  const dropped = new Set<string>();
  for (const entry of branch as any[]) {
    if (entry.type !== "custom") continue;
    if (entry.customType === "om.observations.recorded" && Array.isArray(entry.data?.observations)) {
      const batch: V3Observation[] = [];
      for (const item of entry.data.observations) {
        if (/^[a-f0-9]{12}$/.test(item?.id ?? "") && !observations.has(item.id)) {
          observations.set(item.id, item);
          batch.push(item);
        }
      }
      if (batch.length > 0) recordedBatches.push(batch);
    } else if (entry.customType === "om.observations.dropped" && Array.isArray(entry.data?.observationIds)) {
      for (const id of entry.data.observationIds) if (typeof id === "string") dropped.add(id);
    }
  }
  const all = [...observations.values()];
  return {
    all,
    active: all.filter((item) => !dropped.has(item.id)),
    batches: recordedBatches,
    dropped,
  };
}

function sourceBatchesAtFrozenV3Cadence(branch: Entry[], frozen: Set<string>): Entry[][] {
  const batches: Entry[][] = [];
  const seenObservationIds = new Set<string>();
  let pending: Entry[] = [];
  for (const entry of branch as any[]) {
    if (isSourceEntry(entry)) pending.push(entry);
    if (entry.type !== "custom" || entry.customType !== "om.observations.recorded" || !Array.isArray(entry.data?.observations)) continue;
    let closesBatch = false;
    for (const item of entry.data.observations) {
      if (!/^[a-f0-9]{12}$/.test(item?.id ?? "") || seenObservationIds.has(item.id)) continue;
      seenObservationIds.add(item.id);
      if (frozen.has(item.id)) closesBatch = true;
    }
    if (closesBatch && pending.length > 0) {
      batches.push(pending);
      pending = [];
    }
  }
  return batches;
}

function seedTree(sessionId: string, active: V3Observation[], branch: Entry[]): MemoryTree {
  const ranks = new Map(branch.map((entry, index) => [entry.id, index]));
  const normalized = active.map((item, firstSeen) => ({
    id: `o${firstSeen + 1}`,
    content: singleLine(item.content),
    sourceEntryIds: [...new Set(item.sourceEntryIds.filter((id) => typeof id === "string" && id.trim().length > 0))],
    firstSeen,
  })).filter((item) => item.content && item.sourceEntryIds.length > 0).sort((a, b) => {
    const ar = Math.min(...a.sourceEntryIds.map((id) => ranks.get(id) ?? Number.MAX_SAFE_INTEGER));
    const br = Math.min(...b.sourceEntryIds.map((id) => ranks.get(id) ?? Number.MAX_SAFE_INTEGER));
    return ar - br || a.firstSeen - b.firstSeen;
  });
  const observations = normalized.map(({ firstSeen: _firstSeen, ...item }) => item);
  if (observations.length === 0) throw new Error(`Session ${sessionId} has no usable active V3 observations`);
  const observationsById = new Map(observations.map((item) => [item.id, item]));
  if (observations.length === 1) {
    return { allocation: fixtureAllocation(observations), observationsById, segmentsById: new Map(), root: observations[0], parentByChildId: new Map(), observationBatchesSinceSegmentation: 1, diagnostics: [] };
  }
  const root: Segment = {
    id: "s1",
    title: "Session memory",
    summary: "Active V3 observations awaiting hierarchical organization.",
    childIds: observations.map((item) => item.id),
  };
  return {
    allocation: fixtureAllocation([...observations, root]),
    observationsById,
    segmentsById: new Map([[root.id, root]]),
    root,
    parentByChildId: new Map(root.childIds.map((id) => [id, root.id])),
    observationBatchesSinceSegmentation: 1,
    diagnostics: [],
  };
}

function topology(tree: MemoryTree): string {
  return JSON.stringify({ root: tree.root?.id, segments: [...tree.segmentsById.values()].sort((a, b) => a.id.localeCompare(b.id)).map((item) => [item.id, item.childIds]) });
}

async function responseCall(
  apiKey: string,
  level: Level,
  tree: MemoryTree,
  chunk = "",
  segmentRequired = true,
): Promise<{ proposal: NodeProposal | null; usage: any }> {
  const body = {
    model: MODEL,
    reasoning: { effort: level },
    input: [
      { role: "system", content: [{ type: "input_text", text: SYSTEM_PROMPT }] },
      { role: "user", content: [{ type: "input_text", text: buildObserverUserPrompt({ tree, chunk, segmentRequired, successfulBatches: tree.observationBatchesSinceSegmentation }) }] },
    ],
    tools: [{ type: "function", name: "submit_memory_tree", description: "Submit the single recursive Segment Memory Tree increment for this Observer run.", parameters: OBSERVER_TOOL_SCHEMA }],
    tool_choice: { type: "function", name: "submit_memory_tree" },
  };
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(`${ENDPOINT}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json() as { error?: { message?: string }; output?: Array<{ type: string; name?: string; arguments?: string }>; usage?: unknown };
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${payload?.error?.message ?? JSON.stringify(payload)}`);
      const calls = (payload.output ?? []).filter((item: any) => item.type === "function_call" && item.name === "submit_memory_tree");
      if (calls.length !== 1) throw new Error(`expected exactly one submit_memory_tree call, got ${calls.length}`);
      const parsed = JSON.parse(calls[0].arguments ?? "{}");
      return { proposal: parsed.tree ?? null, usage: payload.usage ?? {} };
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw lastError;
}

function emptyTree(): MemoryTree {
  return {
    allocation: fixtureAllocation([]),
    observationsById: new Map(),
    segmentsById: new Map(),
    parentByChildId: new Map(),
    observationBatchesSinceSegmentation: 0,
    diagnostics: [],
  };
}

function appendFixedBatch(tree: MemoryTree, prepared: Prepared, batch: V3Observation[]): MemoryTree {
  const next = structuredClone(tree) as MemoryTree;
  const globalOrder = new Map([...prepared.seed.observationsById.keys()].map((id, index) => [id, index]));
  const observations = batch
    .map((item) => prepared.seed.observationsById.get(`o${prepared.activeObservations.findIndex((source) => source.id === item.id) + 1}`))
    .filter((item): item is Observation => item !== undefined && !next.observationsById.has(item.id))
    .sort((a, b) => globalOrder.get(a.id)! - globalOrder.get(b.id)!);
  if (observations.length === 0) return next;
  for (const observation of observations) next.observationsById.set(observation.id, observation);
  if (!next.root) {
    if (observations.length === 1) next.root = observations[0];
    else {
      const root: Segment = {
        id: "s1",
        title: "Session memory",
        summary: "Active V3 observations awaiting hierarchical organization.",
        childIds: observations.map((item) => item.id),
      };
      next.root = root;
      next.segmentsById.set(root.id, root);
      for (const observation of observations) next.parentByChildId.set(observation.id, root.id);
    }
  } else if ("content" in next.root) {
    const root: Segment = {
      id: "s1",
      title: "Session memory",
      summary: "Active V3 observations awaiting hierarchical organization.",
      childIds: [next.root.id, ...observations.map((item) => item.id)],
    };
    next.root = root;
    next.segmentsById.set(root.id, root);
    for (const id of root.childIds) next.parentByChildId.set(id, root.id);
  } else {
    const root: Segment = { ...next.root, childIds: [...next.root.childIds, ...observations.map((item) => item.id)] };
    next.root = root;
    next.segmentsById.set(root.id, root);
    for (const observation of observations) next.parentByChildId.set(observation.id, root.id);
  }
  next.allocation = fixtureAllocation([...next.observationsById.values(), ...next.segmentsById.values()], next.allocation);
  next.observationBatchesSinceSegmentation++;
  return next;
}

async function segmentOnce(args: {
  prepared: Prepared;
  level: Level;
  mode: Generated["mode"];
  apiKey: string;
  tree: MemoryTree;
  callNumber: number;
}): Promise<{ tree: MemoryTree; warnings: string[]; usage: any }> {
  const response = await responseCall(args.apiKey, args.level, args.tree);
  const result = applyObserverProposal(args.tree, response.proposal, args.prepared.branch, {
    allowedSourceEntryIds: [],
    segmentRequested: true,
  });
  const tree = { ...result.tree, observationBatchesSinceSegmentation: result.warnings.length > 0 ? 1 : 0 };
  return {
    tree,
    warnings: result.warnings.map((warning) => `call ${args.callNumber}: ${warning}`),
    usage: response.usage,
  };
}

async function generateProgressive(prepared: Prepared, level: Level, apiKey: string): Promise<Generated> {
  let tree = emptyTree();
  const warnings: string[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let rounds = 0;
  for (const batch of prepared.activeBatches) {
    tree = appendFixedBatch(tree, prepared, batch);
    if (tree.observationBatchesSinceSegmentation < 2 || !tree.root || "content" in tree.root) continue;
    rounds++;
    const result = await segmentOnce({ prepared, level, mode: "progressive", apiKey, tree, callNumber: rounds });
    tree = result.tree;
    warnings.push(...result.warnings);
    usage.inputTokens += Number(result.usage.input_tokens ?? 0);
    usage.outputTokens += Number(result.usage.output_tokens ?? 0);
  }
  if (tree.root && "childIds" in tree.root) {
    rounds++;
    const result = await segmentOnce({ prepared, level, mode: "progressive", apiKey, tree, callNumber: rounds });
    tree = result.tree;
    warnings.push(...result.warnings);
    usage.inputTokens += Number(result.usage.input_tokens ?? 0);
    usage.outputTokens += Number(result.usage.output_tokens ?? 0);
  }
  return { prepared, level, mode: "progressive", tree, rounds, warnings, usage };
}

async function generateRawV4(prepared: Prepared, level: Level, apiKey: string): Promise<Generated> {
  let tree = emptyTree();
  let pending: Entry[] = [];
  const warnings: string[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  const normalizationTraces: NormalizationTrace[] = [];
  const sourceLedgerIds = prepared.branch.filter(isSourceEntry).map((entry) => entry.id);
  let rounds = 0;

  const observe = async (forced: boolean) => {
    const serialized = serializeSourceAddressedBranchEntries(pending);
    const segmentRequired = forced || tree.observationBatchesSinceSegmentation + 1 >= 2;
    const successfulBatches = tree.observationBatchesSinceSegmentation;
    const before = snapshotTree(tree);
    rounds++;
    const response = await responseCall(apiKey, level, tree, serialized.text, segmentRequired);
    const beforeCount = tree.observationsById.size;
    const result = applyObserverProposal(tree, response.proposal, prepared.branch, {
      allowedSourceEntryIds: serialized.sourceEntryIds,
      coversUpToId: serialized.sourceEntryIds.at(-1),
      segmentRequested: segmentRequired,
    });
    const newObservationCount = result.tree.observationsById.size - beforeCount;
    const next = structuredClone(result.tree) as MemoryTree;
    if (result.data?.segmentCheck === "complete") next.observationBatchesSinceSegmentation = 0;
    else if (result.data?.segmentCheck === "partial") next.observationBatchesSinceSegmentation = Math.max(1, next.observationBatchesSinceSegmentation);
    else if (newObservationCount > 0) next.observationBatchesSinceSegmentation++;
    tree = next;
    if (result.data?.coversUpToId) pending = [];
    warnings.push(...result.warnings.map((warning) => `call ${rounds}: ${warning}`));
    if (TRACE_NORMALIZATION && result.warnings.length > 0) normalizationTraces.push({
      call: rounds,
      segmentRequired,
      successfulBatches,
      sourceLedgerIds,
      allowedSourceEntryIds: serialized.sourceEntryIds,
      chunk: serialized.text,
      before,
      proposal: response.proposal,
      warnings: result.warnings,
      after: snapshotTree(tree),
    });
    usage.inputTokens += Number(response.usage.input_tokens ?? 0);
    usage.outputTokens += Number(response.usage.output_tokens ?? 0);
  };

  for (const batch of prepared.sourceBatches) {
    pending.push(...batch);
    await observe(false);
  }
  await observe(true);
  return { prepared, level, mode: "raw-v4", tree, rounds, warnings, usage, normalizationTraces };
}

async function generateDirect(prepared: Prepared, level: Level, apiKey: string): Promise<Generated> {
  const usage = { inputTokens: 0, outputTokens: 0 };
  const result = await segmentOnce({
    prepared,
    level,
    mode: "posthoc-single",
    apiKey,
    tree: structuredClone(prepared.seed),
    callNumber: 1,
  });
  usage.inputTokens += Number(result.usage.input_tokens ?? 0);
  usage.outputTokens += Number(result.usage.output_tokens ?? 0);
  return { prepared, level, mode: "posthoc-single", tree: result.tree, rounds: 1, warnings: result.warnings, usage };
}

async function generateIterative(prepared: Prepared, level: Level, apiKey: string): Promise<Generated> {
  let tree = structuredClone(prepared.seed) as MemoryTree;
  const warnings: string[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let rounds = 0;
  while (rounds < MAX_ROUNDS) {
    const before = topology(tree);
    rounds++;
    const result = await segmentOnce({ prepared, level, mode: "posthoc-iterative", apiKey, tree, callNumber: rounds });
    tree = result.tree;
    warnings.push(...result.warnings);
    usage.inputTokens += Number(result.usage.input_tokens ?? 0);
    usage.outputTokens += Number(result.usage.output_tokens ?? 0);
    if (topology(tree) === before) break;
  }
  return { prepared, level, mode: "posthoc-iterative", tree, rounds, warnings, usage };
}

function metrics(result: Generated) {
  const tree = result.tree;
  const rendered = renderMemoryTree(tree, maxTreeDepth(tree));
  const flatTokens = estimateStringTokens([...tree.observationsById.values()].map((item) => `[${item.id}] ${item.content}`).join("\n"));
  const rootChildren = tree.root && "childIds" in tree.root ? tree.root.childIds.length : 0;
  const groupedLeaves = [...tree.observationsById.keys()].filter((id) => tree.parentByChildId.get(id) !== tree.root?.id).length;
  return {
    observations: tree.observationsById.size,
    segments: tree.segmentsById.size,
    maxDepth: maxTreeDepth(tree),
    rootChildren,
    groupedLeaves,
    renderedTokens: rendered.estimatedTokens,
    flatTokens,
    compressionPercent: flatTokens > 0 ? Math.round(rendered.estimatedTokens / flatTokens * 10_000) / 100 : 0,
  };
}

function treeMarkdown(result: Generated): string {
  const m = metrics(result);
  const body = renderMemoryTree(result.tree, maxTreeDepth(result.tree)).markdown;
  return [
    `# V4 Segment Memory Tree — ${result.level} / ${result.mode}`,
    "",
    `- Session ID: \`${result.prepared.info.id}\``,
    `- Model: \`${MODEL}\``,
    `- Reasoning effort: \`${result.level}\``,
    `- Build mode: \`${result.mode}\``,
    `- Input mode: ${result.mode === "raw-v4" ? "original source entries replayed at frozen V3 cadence; V4 generated both Observations and Segments" : `fixed active V3 Observations; ${result.mode === "progressive" ? "replayed in original V3 record batches with segmentation every two batches plus one final forced call" : result.mode === "posthoc-single" ? "all leaves supplied before one Observer call" : "all leaves supplied before independent Observer calls repeated until topology stabilized or six calls"}`}.`,
    `- Observer calls: ${result.rounds}`,
    `- Observations: ${m.observations}${result.mode === "raw-v4" ? " (generated by V4)" : " (fixed)"}`,
    `- Segments: ${m.segments}`,
    `- Maximum depth: ${m.maxDepth}`,
    `- Root direct children: ${m.rootChildren}`,
    `- Leaves grouped below Root: ${m.groupedLeaves}`,
    `- Full render estimate: ${m.renderedTokens} tokens (${m.compressionPercent}% of flat Observation estimate ${m.flatTokens})`,
    `- API usage: ${result.usage.inputTokens} input tokens, ${result.usage.outputTokens} output tokens`,
    `- Normalization warnings: ${result.warnings.length}`,
    ...(result.warnings.length ? ["", "## Normalization warnings", "", ...result.warnings.map((warning) => `- ${warning}`)] : []),
    "",
    "## Complete tree",
    "",
    body,
    "",
  ].join("\n");
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
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

if (CANARY) await rm(OUTPUT_ROOT, { recursive: true, force: true });
await mkdir(OUTPUT_ROOT, { recursive: true });
const infos = await SessionManager.listAll();
const prepared: Prepared[] = [];
const selectedIds = process.env.EVAL_SESSION_IDS?.split(",") ?? (CANARY ? [SELECTIONS.find((item) => item.label === "swarm-forge")!.id] : SESSION_IDS);
for (const id of selectedIds) {
  const info = infos.find((candidate: any) => candidate.id === id);
  if (!info) throw new Error(`Session ${id} not found`);
  const manager = SessionManager.open(info.path);
  const branch = manager.getBranch() as Entry[];
  const folded = foldV3(branch);
  const slug = `${basename(info.cwd || "session")}-${id.slice(0, 8)}`;
  const dir = join(OUTPUT_ROOT, slug);
  await mkdir(dir, { recursive: true });
  const selection = SELECTIONS.find((item) => item.id === id)!;
  const frozen = new Set(selection.activeObservationIds);
  const activeObservations = folded.all.filter((item) => frozen.has(item.id));
  const activeIds = new Set(activeObservations.map((item) => item.id));
  const activeBatches = folded.batches.map((batch) => batch.filter((item) => activeIds.has(item.id))).filter((batch) => batch.length > 0);
  if (activeObservations.length !== frozen.size) throw new Error(`Frozen Observation mismatch for ${id}: expected ${frozen.size}, found ${activeObservations.length}`);
  const item: Prepared = {
    info,
    branch,
    allObservations: folded.all,
    activeObservations,
    activeBatches,
    sourceBatches: sourceBatchesAtFrozenV3Cadence(branch, frozen),
    droppedObservationIds: new Set(selection.droppedObservationIds),
    dir,
    seed: seedTree(id, activeObservations, branch),
  };
  prepared.push(item);
  await writeFile(join(dir, "source-conversation.md"), sourceMarkdown(item), "utf8");
  await writeFile(join(dir, "v3-observations.md"), v3Markdown(item), "utf8");
}

if (!process.env.API_KEY) process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
const apiKey = process.env.API_KEY;
if (!apiKey) throw new Error("API_KEY is missing after loading .env");

const tasks = prepared.flatMap((item) => LEVELS.flatMap((level) => MODES.map((mode) => ({ item, level, mode }))));
const generated = await mapLimit(tasks, 3, async ({ item, level, mode }) => {
  console.error(`Generating ${item.info.id} ${level} ${mode}...`);
  const result = mode === "progressive"
    ? await generateProgressive(item, level, apiKey)
    : mode === "posthoc-single"
      ? await generateDirect(item, level, apiKey)
      : mode === "posthoc-iterative"
        ? await generateIterative(item, level, apiKey)
        : await generateRawV4(item, level, apiKey);
  const suffix = mode === "progressive" ? "" : `-${mode}`;
  await writeFile(join(item.dir, `v4-tree-${level}${suffix}.md`), treeMarkdown(result), "utf8");
  if (TRACE_NORMALIZATION && result.normalizationTraces) {
    await writeFile(join(item.dir, `normalization-traces-${level}${suffix}.json`), JSON.stringify({
      sessionId: item.info.id,
      model: MODEL,
      level,
      mode,
      systemPrompt: SYSTEM_PROMPT,
      traces: result.normalizationTraces,
    }, null, 2), "utf8");
  }
  return result;
});
for (const result of generated) {
  if (result.mode === "raw-v4") continue;
  const expected = new Set(result.prepared.activeObservations.map((_item, index) => `o${index + 1}`));
  const actual = new Set(result.tree.observationsById.keys());
  if (expected.size !== actual.size || [...expected].some((id) => !actual.has(id))) {
    throw new Error(`Observation leaf mismatch for ${result.prepared.info.id}/${result.level}/${result.mode}`);
  }
}

const metricTable = [
  "| Session | Effort | Mode | Obs | Segments | Depth | Root children | Grouped leaves | Render/flat | Warnings | Calls |",
  "|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ...generated.map((result) => {
    const m = metrics(result);
    return `| ${basename(result.prepared.info.cwd)} (${result.prepared.info.id.slice(0, 8)}) | ${result.level} | ${result.mode} | ${m.observations} | ${m.segments} | ${m.maxDepth} | ${m.rootChildren} | ${m.groupedLeaves} | ${m.compressionPercent}% | ${result.warnings.length} | ${result.rounds} |`;
  }),
].join("\n");
const rawOnly = MODES.length === 1 && MODES[0] === "raw-v4";
const report = [
  `# V4 ${rawOnly ? "raw-source" : "fixed-V3-leaf"} ${CANARY ? "canary" : "evaluation"} report`,
  "",
  "## Method",
  "",
  `- Selected Sessions: ${prepared.map((item) => `${basename(item.info.cwd)}: ${item.activeObservations.length} active V3 Observations in ${item.activeBatches.length} retained batches`).join("; ")}.`,
  ...(rawOnly ? [
    "- Original source entries were replayed at the frozen V3 batch boundaries; V3 Observation content was not sent to the model.",
    "- V4 generated both source-backed Observation leaves and Segment hierarchy, checked by production normalization and strict tree validation.",
  ] : [
    "- V3 first-valid-record-wins folding and Dropper tombstones produced immutable active leaves; every output leaf set was checked for exact identity.",
    "- Progressive mode replays retained V3 record batches, calls Observer after every two batches, and makes one final forced call.",
    "- Post-hoc single mode supplies all fixed leaves before exactly one Observer call.",
    "- Post-hoc iterative mode repeats from the full flat Root until topology stabilizes or six calls.",
    "- Original conversations were exported locally but were not sent to the API.",
  ]),
  `- ${MODEL} used the production V4 prompt, tool schema, proposal normalization, invariant validation, and unlimited-depth renderer; API concurrency was capped at three.`,
  "",
  "## Structural metrics",
  "",
  metricTable,
  "",
].join("\n");
await writeFile(join(OUTPUT_ROOT, CANARY ? "canary-report.md" : "run-report.md"), report, "utf8");
console.log(JSON.stringify({ outputRoot: OUTPUT_ROOT, canary: CANARY, sessions: prepared.length, trees: generated.length }, null, 2));
