import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, truncateHead } from "@earendil-works/pi-coding-agent";
import { SessionCatalog } from "../sessions/catalog.js";

export function registerOmSessionsTool(pi: ExtensionAPI, catalog = new SessionCatalog()): void {
	pi.registerTool(defineTool({
		name: "om_sessions",
		label: "List memory sessions",
		description: "Discover local persisted Pi Sessions that contain Segment Memory. Path defaults to the current cwd; every keyword must match the Root Segment title or summary.",
		promptSnippet: "Discover local persisted Pi Sessions that contain Segment Memory",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Directory boundary to search under. Defaults to the current cwd." })),
			keywords: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "All case-insensitive keywords must match the Root Segment title + summary." })),
		}),
		async execute(_id, params, signal, _update, ctx) {
			signal?.throwIfAborted();
			const sessions = await catalog.list(params.path ?? ctx.cwd, params.keywords ?? []);
			const full = JSON.stringify({ sessions }, null, 2);
			const output = truncateHead(full);
			return {
				content: [{ type: "text", text: output.truncated ? `${output.content}\n\n[Output truncated: ${sessions.length} sessions matched.]` : output.content }],
				details: { sessions, truncated: output.truncated },
			};
		},
	}));
}
