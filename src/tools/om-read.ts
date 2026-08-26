import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, truncateHead } from "@earendil-works/pi-coding-agent";
import { exportMemory, type ExportFormat, type SessionExportIdentity } from "../memory-tree/export.js";
import { MemoryTreeStore } from "../memory-tree/store.js";
import type { Entry, MemoryTree } from "../memory-tree/types.js";
import { SessionCatalog } from "../sessions/catalog.js";

function lineCount(value: string): number {
	return value.length === 0 ? 0 : value.split("\n").length;
}

export function registerOmReadTool(pi: ExtensionAPI, catalog = new SessionCatalog()): void {
	pi.registerTool(defineTool({
		name: "om_read",
		label: "Read memory tree",
		description: "Read a Segment or Observation from the current or an exact local persisted Pi Session. depth=-1 expands the full subtree. JSONL can be exported for analysis.",
		promptSnippet: "Read or expand Segment Memory nodes by exact node and optional Session ID",
		parameters: Type.Object({
			sessionId: Type.Optional(Type.String({ minLength: 1, description: "Exact Session ID. Omit for the current active branch." })),
			nodeId: Type.Optional(Type.String({ minLength: 1, description: "Node ID. Omit for the Root." })),
			depth: Type.Optional(Type.Integer({ minimum: -1, description: "Descendant depth; -1 means the complete subtree. Default 1." })),
			includeSummary: Type.Optional(Type.Boolean({ description: "Include Segment summaries. Default true." })),
			format: Type.Optional(StringEnum(["markdown", "json", "jsonl"] as const)),
			outputPath: Type.Optional(Type.String({ minLength: 1, description: "Write the complete result to this path and return compact metadata." })),
		}),
		async execute(_id, params, signal, _update, ctx) {
			signal?.throwIfAborted();
			let tree: MemoryTree;
			let identity: SessionExportIdentity;
			const currentSessionId = ctx.sessionManager.getSessionId?.();
			if (!params.sessionId || params.sessionId === currentSessionId) {
				tree = new MemoryTreeStore().rebuild(ctx.sessionManager.getBranch() as Entry[]);
				identity = { sessionId: currentSessionId ?? "ephemeral", name: ctx.sessionManager.getSessionName?.(), cwd: ctx.cwd };
			} else {
				const located = await catalog.locate(params.sessionId);
				tree = located.tree;
				identity = { sessionId: located.info.id, name: located.name ?? located.info.name, cwd: located.info.cwd };
			}
			const format = (params.format ?? "markdown") as ExportFormat;
			const output = exportMemory(tree, identity, {
				nodeId: params.nodeId,
				depth: params.depth,
				includeSummary: params.includeSummary,
				format,
			});
			if (params.outputPath) {
				const path = resolve(ctx.cwd, params.outputPath.replace(/^@/, ""));
				await mkdir(dirname(path), { recursive: true });
				await writeFile(path, output, "utf8");
				const bytes = Buffer.byteLength(output);
				const details = { path, format, lines: lineCount(output), bytes, sessionId: identity.sessionId, nodeId: params.nodeId ?? tree.root?.id };
				return { content: [{ type: "text", text: `Wrote ${details.lines} lines (${bytes} bytes) to ${path}` }], details };
			}
			const truncated = truncateHead(output);
			return {
				content: [{ type: "text", text: truncated.truncated ? `${truncated.content}\n\n[Output truncated. Use outputPath for the complete result.]` : truncated.content }],
				details: { sessionId: identity.sessionId, nodeId: params.nodeId ?? tree.root?.id, format, truncated: truncated.truncated },
			};
		},
	}));
}
