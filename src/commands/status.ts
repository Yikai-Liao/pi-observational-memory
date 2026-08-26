import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveCompactAfterTokens } from "../config.js";
import { maxTreeDepth, renderMemoryTree } from "../memory-tree/render.js";
import { MemoryTreeStore } from "../memory-tree/store.js";
import type { Entry } from "../memory-tree/types.js";
import { rawTokensSinceLastCompaction, rawTokensSinceObservationCoverage } from "../progress.js";
import type { Runtime } from "../runtime.js";
import { estimateStringTokens } from "../tokens.js";

const pct = (current: number, total: number) => total > 0 ? Math.round(current / total * 100) : 0;

export function registerStatusCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:status", {
		description: "Show Segment Memory Tree status",
		handler: async (_args, ctx) => {
			runtime.ensureConfig(ctx.cwd);
			const entries = ctx.sessionManager.getBranch() as Entry[];
			let tree;
			try {
				tree = new MemoryTreeStore().rebuild(entries);
			} catch (error) {
				ctx.ui.notify(`── Diagnostics ──\nTree validation: invalid\n${error instanceof Error ? error.message : String(error)}`, "warning");
				return;
			}
			const rendered = renderMemoryTree(tree, runtime.config.memoryDepth);
			const flatTokens = estimateStringTokens([...tree.observationsById.values()].map((item) => `[${item.id}] ${item.content}`).join("\n"));
			const rootChildren = tree.root && "childIds" in tree.root ? tree.root.childIds : [];
			const rootSegments = rootChildren.filter((id) => tree.segmentsById.has(id as `s_${string}`)).length;
			const observationProgress = rawTokensSinceObservationCoverage(entries);
			const compactionProgress = rawTokensSinceLastCompaction(entries);
			const threshold = resolveCompactAfterTokens(runtime.config, ctx.model?.contextWindow);
			const lines = [
				"── Memory tree ──",
				`Observations: ${tree.observationsById.size}`,
				`Segments: ${tree.segmentsById.size}`,
				`Root: ${tree.root ? ("childIds" in tree.root ? `segment / ${rootChildren.length} children (${rootSegments} segments, ${rootChildren.length - rootSegments} observations)` : "observation") : "none"}`,
				`Tree depth: max ${maxTreeDepth(tree)}`,
				`Render depth: ${runtime.config.memoryDepth}`,
				`Rendered nodes: ${rendered.nodes.length} / ~${rendered.estimatedTokens.toLocaleString()} tokens`,
				`Flat observations: ~${flatTokens.toLocaleString()} tokens`,
				`Rendered vs flat observations: ${pct(rendered.estimatedTokens, flatTokens)}%`,
				"",
				"── Activity ──",
				`Next observation: ~${observationProgress.toLocaleString()} / ${runtime.config.observeAfterTokens.toLocaleString()} tokens (${pct(observationProgress, runtime.config.observeAfterTokens)}%)`,
				`Next segmentation: ${tree.observationBatchesSinceSegmentation} / ${runtime.config.segmentEveryObserverRuns} successful Observer batches`,
				`Next compaction: ~${compactionProgress.toLocaleString()} / ${threshold.toLocaleString()} estimated source tokens (${pct(compactionProgress, threshold)}%)`,
				`Observer: ${runtime.consolidationInFlight ? "running" : "idle"}`,
				`Last observer error: ${runtime.lastObserverError ?? "none"}`,
				"",
				"── Diagnostics ──",
				`Last proposal warning: ${tree.diagnostics.at(-1)?.message ?? "none"}`,
				"Tree validation: valid",
			];
			if (runtime.config.passive) lines.unshift("── Mode ──", "Passive: background Observer and auto-compaction disabled; compaction, commands, and memory tools remain active", "");
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
