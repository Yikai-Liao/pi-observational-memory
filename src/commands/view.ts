import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { copyTextToClipboard } from "../clipboard.js";
import { maxTreeDepth, renderMemoryTree } from "../memory-tree/render.js";
import { readSessionMemory } from "../sessions/memory.js";
import type { Runtime } from "../runtime.js";

function modeFrom(args: unknown): string | undefined {
	if (typeof args === "string") return args.trim().split(/\s+/)[0] || undefined;
	if (Array.isArray(args)) return typeof args[0] === "string" ? args[0] : undefined;
	return undefined;
}

export function registerViewCommand(
	pi: ExtensionAPI,
	runtime: Runtime,
	options: { copyToClipboard?: (text: string) => Promise<boolean> } = {},
): void {
	const copy = options.copyToClipboard ?? copyTextToClipboard;
	pi.registerCommand("om:view", {
		description: "Print and copy the visible Segment Memory Tree; use current for the full tree",
		handler: async (args, ctx) => {
			runtime.ensureConfig(ctx.cwd);
			const mode = modeFrom(args) ?? "visible";
			if (mode !== "visible" && mode !== "current") {
				ctx.ui.notify("Usage: /om:view [visible|current]", "info");
				return;
			}
			let tree;
			try {
				tree = readSessionMemory(ctx.sessionManager);
			} catch (error) {
				ctx.ui.notify(`Memory tree unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
				return;
			}
			const depth = mode === "current" ? maxTreeDepth(tree) : runtime.config.memoryDepth;
			const output = renderMemoryTree(tree, depth).markdown || "No Segment Memory has been recorded yet.";
			const copied = await copy(output).catch(() => false);
			ctx.ui.notify(`${output}\n\n${copied ? "Copied /om:view output to clipboard." : "Warning: failed to copy /om:view output to clipboard."}`, "info");
		},
	});
}
