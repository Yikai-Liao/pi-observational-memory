import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, truncateHead } from "@earendil-works/pi-coding-agent";
import { SessionCatalog } from "../sessions/catalog.js";

export const OM_SESSIONS_DESCRIPTION = "Discover local persisted Pi Sessions that contain Segment Memory. Omit path for current cwd and omit keywords unless the user explicitly asks for content filtering; every supplied keyword must match the Root Segment title or summary.";
export const OM_SESSIONS_GUIDELINE = "For om_sessions, omit path when the user means the current working directory; omit keywords when the user did not provide content keywords. Never invent '.', an empty path, or generic keywords such as 'Segment'.";

export const OM_SESSIONS_SCHEMA = Type.Object({
	path: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Explicit directory boundary supplied by the user. Use null for the current cwd; never substitute '.'." })),
	keywords: Type.Optional(Type.Union([Type.Array(Type.String({ minLength: 1 })), Type.Null()], { description: "Only content keywords explicitly requested by the user; every item must match Root title + summary. Use null when none were requested; never infer generic words such as 'Segment'." })),
});

export function normalizeOmSessionsArguments(args: unknown): { path?: string | null; keywords?: string[] | null } {
	if (!args || typeof args !== "object") return args as { path?: string | null; keywords?: string[] | null };
	const input = { ...(args as Record<string, unknown>) };
	if (input.path === null || (typeof input.path === "string" && ["", "."].includes(input.path.trim()))) delete input.path;
	if (input.keywords === null) delete input.keywords;
	return input;
}

export function registerOmSessionsTool(pi: ExtensionAPI, catalog = new SessionCatalog()): void {
	pi.registerTool(defineTool({
		name: "om_sessions",
		label: "List memory sessions",
		description: OM_SESSIONS_DESCRIPTION,
		promptSnippet: "Discover local persisted Pi Sessions that contain Segment Memory",
		promptGuidelines: [OM_SESSIONS_GUIDELINE],
		parameters: OM_SESSIONS_SCHEMA,
		prepareArguments: normalizeOmSessionsArguments,
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
