import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { debugLog } from "../debug-log.js";
import { renderMemoryTree } from "../memory-tree/render.js";
import { MemoryTreeStore } from "../memory-tree/store.js";
import type { Entry } from "../memory-tree/types.js";
import type { Runtime } from "../runtime.js";
import { runObserverOnce } from "./consolidation-trigger.js";

const store = new MemoryTreeStore();

export function registerCompactionHook(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
		if (runtime.compactHookInFlight) {
			if (ctx.hasUI) ctx.ui.notify("Observational memory: another compaction is already in progress; cancelling duplicate", "warning");
			return { cancel: true };
		}
		runtime.compactHookInFlight = true;
		try {
			runtime.ensureConfig(ctx.cwd);
			try {
				await runObserverOnce(pi, runtime, ctx as any, { forced: true, signal: event.signal });
			} catch (error) {
				const message = runtime.recordConsolidationStageError(ctx, "observer", error);
				if (ctx.hasUI) ctx.ui.notify(`Observational memory: compaction cancelled because forced Observer failed: ${message}`, "warning");
				return { cancel: true };
			}

			let tree;
			try {
				tree = store.rebuild(ctx.sessionManager.getBranch() as Entry[]);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (ctx.hasUI) ctx.ui.notify(`Observational memory: compaction cancelled because the memory tree is invalid: ${message}`, "warning");
				debugLog("tree.rebuild_failed", { reason: "compaction", errorMessage: message });
				return { cancel: true };
			}
			if (!tree.root) return;

			const rendered = renderMemoryTree(tree, runtime.config.memoryDepth);
			debugLog("render.completed", {
				memoryDepth: runtime.config.memoryDepth,
				renderedNodeCount: rendered.nodes.length,
				estimatedTokens: rendered.estimatedTokens,
			});
			return {
				compaction: {
					summary: rendered.markdown,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details: rendered.details,
				},
			};
		} finally {
			runtime.compactHookInFlight = false;
		}
	});
}
