import { resolve, relative } from "node:path";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { maxTreeDepth } from "../memory-tree/render.js";
import { nodePreview } from "../memory-tree/node.js";
import { MemoryTreeStore } from "../memory-tree/store.js";
import { isSegment, type Entry, type MemoryTree } from "../memory-tree/types.js";

export type SessionSummary = {
	sessionId: string;
	sessionName?: string;
	cwd?: string;
	startedAt: string;
	updatedAt: string;
	parentSessionId?: string;
	root:
		| { kind: "segment"; nodeId: string; title: string; summary: string; childCount: number }
		| { kind: "observation"; nodeId: string; preview: string };
	observationCount: number;
	segmentCount: number;
	maxDepth: number;
	topLevel: Array<{ nodeId: string; kind: "segment" | "observation"; preview: string }>;
};

export type LocatedSession = {
	info: SessionInfo;
	tree: MemoryTree;
	entries: Entry[];
	name?: string;
	parentSessionId?: string;
};

type SessionManagerStatic = Pick<typeof SessionManager, "listAll" | "open">;

function withinPath(cwd: string, base: string): boolean {
	const value = relative(resolve(base), resolve(cwd));
	return value === "" || (!value.startsWith("..") && !value.startsWith("/") && !value.startsWith("\\"));
}

export class SessionCatalog {
	constructor(private readonly sessions: SessionManagerStatic = SessionManager) {}

	private async all(): Promise<SessionInfo[]> {
		return this.sessions.listAll();
	}

	async locate(sessionId: string): Promise<LocatedSession> {
		const all = await this.all();
		const matches = all.filter((item) => item.id === sessionId);
		if (matches.length === 0) throw new Error(`Session ${sessionId} was not found`);
		if (matches.length > 1) throw new Error(`Session ID ${sessionId} is not unique`);
		const info = matches[0]!;
		const manager = this.sessions.open(info.path);
		const entries = manager.getBranch() as Entry[];
		const tree = new MemoryTreeStore().rebuild(entries);
		if (!tree.root) throw new Error(`Session ${sessionId} has no Segment Memory`);
		const parentSessionId = info.parentSessionPath ? all.find((item) => resolve(item.path) === resolve(info.parentSessionPath!))?.id : undefined;
		return { info, tree, entries, name: manager.getSessionName(), parentSessionId };
	}

	async list(path: string, keywords: string[] = []): Promise<SessionSummary[]> {
		const all = await this.all();
		const idsByPath = new Map(all.map((item) => [resolve(item.path), item.id]));
		const results: SessionSummary[] = [];
		for (const info of all.filter((item) => item.cwd && withinPath(item.cwd, path))) {
			try {
				const manager = this.sessions.open(info.path);
				const tree = new MemoryTreeStore().rebuild(manager.getBranch() as Entry[]);
				if (!tree.root) continue;
				if (keywords.length > 0) {
					if (!isSegment(tree.root)) continue;
					const haystack = `${tree.root.title} ${tree.root.summary}`.toLowerCase();
					if (!keywords.every((keyword) => haystack.includes(keyword.toLowerCase()))) continue;
				}
				const root = isSegment(tree.root)
					? { kind: "segment" as const, nodeId: tree.root.id, title: tree.root.title, summary: tree.root.summary, childCount: tree.root.childIds.length }
					: { kind: "observation" as const, nodeId: tree.root.id, preview: tree.root.content.slice(0, 240) };
				const childIds = isSegment(tree.root) ? tree.root.childIds : [];
				results.push({
					sessionId: info.id,
					...(manager.getSessionName() ? { sessionName: manager.getSessionName() } : {}),
					...(info.cwd ? { cwd: info.cwd } : {}),
					startedAt: info.created.toISOString(),
					updatedAt: info.modified.toISOString(),
					...(info.parentSessionPath && idsByPath.get(resolve(info.parentSessionPath)) ? { parentSessionId: idsByPath.get(resolve(info.parentSessionPath)) } : {}),
					root,
					observationCount: tree.observationsById.size,
					segmentCount: tree.segmentsById.size,
					maxDepth: maxTreeDepth(tree),
					topLevel: childIds.slice(0, 3).flatMap((id) => {
						const node = tree.observationsById.get(id) ?? tree.segmentsById.get(id as `s_${string}`);
						return node ? [{ nodeId: node.id, kind: isSegment(node) ? "segment" as const : "observation" as const, preview: nodePreview(node).slice(0, 240) }] : [];
					}),
				});
			} catch {
				// Discovery omits unreadable/non-V4 sessions; exact locate reports errors.
			}
		}
		return results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}
}
