import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, truncateHead } from "@earendil-works/pi-coding-agent";
import { exportMemory, type ExportFormat, type SessionExportIdentity } from "../memory-tree/export.js";
import { readSessionMemory } from "../sessions/memory.js";
import type { Entry, MemoryTree } from "../memory-tree/types.js";
import { SessionCatalog } from "../sessions/catalog.js";

export const OM_READ_DESCRIPTION = "Read or expand a Segment or Observation from the current or an exact local persisted Pi Session.";
export const OM_READ_GUIDELINE = "Expand memory when its details matter to the task. Read the current Session directly; discover an unknown historical Session ID with om_sessions.";

export const OM_READ_SCHEMA = Type.Object({
	sessionId: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()], { description: "Known exact Session ID from the user or om_sessions. Omit or use null for the current active branch; never invent an ID, write 'current', or substitute a node ID." })),
	nodeId: Type.Optional(Type.Union([Type.String({ pattern: "^[so][1-9][0-9]*$" }), Type.Null()], { description: "Exact Session-scoped short node ID (s12 for a Segment, o38 for an Observation) from the user, rendered memory, or tool results. Omit or use null for the Root. Reads stored memory, not raw conversation text." })),
	depth: Type.Optional(Type.Integer({ minimum: -1, description: "Descendant depth; -1 means the complete subtree. Default 1." })),
	includeSummary: Type.Optional(Type.Boolean({ description: "Include Segment summaries. Default true." })),
	format: Type.Optional(StringEnum(["markdown", "json", "jsonl"] as const)),
	outputPath: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()], { description: "Use only when the user explicitly asks to write/save/export to this exact path. Use null for normal inline markdown/JSON/JSONL output; never invent a temporary path." })),
});

type OmReadArguments = { sessionId?: string | null; nodeId?: string | null; depth?: number; includeSummary?: boolean; format?: "markdown" | "json" | "jsonl"; outputPath?: string | null };

export function normalizeOmReadArguments(args: unknown): OmReadArguments {
	if (!args || typeof args !== "object") return args as OmReadArguments;
	const input = { ...(args as Record<string, unknown>) };
	if (input.sessionId === null || (typeof input.sessionId === "string" && ["", "current"].includes(input.sessionId.trim().toLowerCase()))) delete input.sessionId;
	if (input.nodeId === null) delete input.nodeId;
	if (input.outputPath === null || (typeof input.outputPath === "string" && input.outputPath.trim() === "")) delete input.outputPath;
	return input;
}

function lineCount(value: string): number {
	return value.length === 0 ? 0 : value.split("\n").length;
}

export function registerOmReadTool(pi: ExtensionAPI, catalog = new SessionCatalog()): void {
	pi.registerTool(defineTool({
		name: "om_read",
		label: "Read memory tree",
		description: OM_READ_DESCRIPTION,
		promptSnippet: "Read or expand Segment Memory nodes by exact node and optional Session ID",
		promptGuidelines: [OM_READ_GUIDELINE],
		parameters: OM_READ_SCHEMA,
		prepareArguments: normalizeOmReadArguments,
		async execute(_id, params, signal, _update, ctx) {
			signal?.throwIfAborted();
			let tree: MemoryTree;
			let identity: SessionExportIdentity;
			const currentSessionId = ctx.sessionManager.getSessionId?.();
			if (!params.sessionId || params.sessionId === currentSessionId) {
				tree = readSessionMemory(ctx.sessionManager);
				identity = { sessionId: currentSessionId ?? "ephemeral", name: ctx.sessionManager.getSessionName?.(), cwd: ctx.cwd };
			} else {
				const located = await catalog.locate(params.sessionId);
				tree = located.tree;
				identity = { sessionId: located.info.id, name: located.name ?? located.info.name, cwd: located.info.cwd };
			}
			const format = (params.format ?? "markdown") as ExportFormat;
			const output = exportMemory(tree, identity, {
				nodeId: params.nodeId ?? undefined,
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
