import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { applyObserverProposal } from "../src/memory-tree/store.js";
import { renderMemoryTree } from "../src/memory-tree/render.js";
import { OM_NODE_IDS_INHERITED, OM_OBSERVATIONS_RECORDED, type Entry, type NodeProposal } from "../src/memory-tree/types.js";
import { SessionCatalog } from "../src/sessions/catalog.js";
import { captureForkIds, initializeForkIds } from "../src/sessions/fork.js";
import { readSessionMemory } from "../src/sessions/memory.js";
import { SessionWriter } from "../src/sessions/writer.js";

const directories: string[] = [];
const writers: SessionWriter[] = [];
afterEach(() => {
	for (const writer of writers.splice(0)) writer.release();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function writer(manager: SessionManager) {
	const result = new SessionWriter();
	writers.push(result);
	result.claim(manager);
	return result;
}
function persisted() {
	const dir = mkdtempSync(join(tmpdir(), "om-node-ids-"));
	directories.push(dir);
	const manager = SessionManager.create(dir, dir);
	manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Start." }], timestamp: 1 } as any);
	return manager;
}
function proposal(manager: SessionManager, text: string) {
	const raw = manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
	const tree = readSessionMemory(manager);
	const leaf: NodeProposal = { type: "observation", content: text, sourceEntryIds: [raw] };
	const value: NodeProposal = !tree.root ? leaf : "childIds" in tree.root
		? { type: "segment", id: tree.root.id, title: "Work", summary: "Recorded decisions.", children: [leaf] }
		: { type: "segment", title: "Work", summary: "Recorded decisions.", children: [{ type: "ref", id: tree.root.id }, leaf] };
	return applyObserverProposal(tree, value, manager.getBranch() as Entry[], { allowedSourceEntryIds: [raw], coversUpToId: raw, segmentRequested: false }).data!;
}
function record(manager: SessionManager, text: string) {
	return manager.appendCustomEntry(OM_OBSERVATIONS_RECORDED, proposal(manager, text));
}
function forkInit(manager: SessionManager, reason = "fork", previousSessionFile?: string) {
	initializeForkIds(manager, (type, data) => manager.appendCustomEntry(type, data), { reason, previousSessionFile });
}

describe("Pi Session node-ID lifecycle", () => {
	it("restores the whole-session watermark while replaying only the selected branch", () => {
		const manager = persisted();
		const first = record(manager, "First decision.");
		record(manager, "Branch A decision.");
		manager.branch(first);
		record(manager, "Branch B decision.");
		const tree = readSessionMemory(manager);
		expect(tree.root).toMatchObject({ id: "s2", childIds: ["o1", "o3"] });
		expect(tree.observationsById.has("o2")).toBe(false);
		expect(tree.allocation.birthEntryById.has("o2")).toBe(true);
		const reopened = SessionManager.open(manager.getSessionFile()!);
		expect(readSessionMemory(reopened)).toEqual(tree);
	});

	it("inherits source watermarks outside copied ancestry and keeps historical reads read-only", async () => {
		const source = persisted();
		const first = record(source, "First decision.");
		record(source, "Later decision only on the source.");
		const file = source.getSessionFile()!;
		captureForkIds(source);
		const fork = SessionManager.open(file);
		fork.createBranchedSession(first);
		expect(() => readSessionMemory(fork)).toThrow(/not initialized/);
		forkInit(fork, "fork", file);
		const inherited = fork.getEntries().find((entry) => entry.type === "custom" && entry.customType === OM_NODE_IDS_INHERITED);
		expect((inherited as any).data).toMatchObject({ sessionId: fork.getSessionId(), sourceSessionId: source.getSessionId(), highWater: { observation: "2", segment: "1" } });
		const before = fork.getEntries().length;
		forkInit(fork, "reload", file);
		expect(fork.getEntries()).toHaveLength(before);
		record(fork, "Fork decision.");
		expect(readSessionMemory(fork).root).toMatchObject({ id: "s2", childIds: ["o1", "o3"] });
		// The source independently allocates the same next Observation ID.
		record(source, "Source decision.");
		expect(readSessionMemory(source).observationsById.has("o3")).toBe(true);
		const path = fork.getSessionFile()!;
		const contents = readFileSync(path, "utf8");
		const info = { id: fork.getSessionId(), path, cwd: fork.getCwd(), created: new Date(), modified: new Date(), messageCount: 1, firstMessage: "", allMessagesText: "", parentSessionPath: file };
		const catalog = new SessionCatalog({ listAll: async () => [info], open: SessionManager.open } as any);
		expect((await catalog.locate(info.id)).tree.root?.id).toBe("s2");
		expect((await catalog.list(fork.getCwd()))[0]).toMatchObject({ root: { nodeId: "s2" }, topLevel: [{ nodeId: "o1" }, { nodeId: "o3" }] });
		expect(readFileSync(path, "utf8")).toBe(contents);
	});

	it("recovers unfinished persisted Fork initialization from the source ledger", () => {
		const source = persisted();
		const first = record(source, "First decision.");
		record(source, "Hidden source decision.");
		const fork = SessionManager.open(source.getSessionFile()!);
		fork.createBranchedSession(first);
		const reopened = SessionManager.open(fork.getSessionFile()!);
		forkInit(reopened, "resume");
		expect(readSessionMemory(reopened).allocation.highWater).toEqual({ observation: "2", segment: "1" });
	});

	it("does not guess when a Fork source is unavailable", () => {
		const source = persisted();
		const first = record(source, "First decision.");
		const fork = SessionManager.open(source.getSessionFile()!);
		fork.createBranchedSession(first);
		rmSync(source.getSessionFile()!);
		expect(() => forkInit(fork, "resume")).toThrow(/unavailable/);
		expect(() => readSessionMemory(fork)).toThrow(/not initialized/);
	});

	it("carries in-memory Fork snapshots across Pi runtime replacement, including a fork before all memory", () => {
		const manager = SessionManager.inMemory("/ephemeral");
		const first = record(manager, "First temporary decision.");
		record(manager, "Hidden temporary decision.");
		captureForkIds(manager);
		manager.createBranchedSession(first);
		forkInit(manager);
		record(manager, "Forked temporary decision.");
		expect(readSessionMemory(manager).root?.id).toBe("s2");
		expect(manager.getSessionFile()).toBeUndefined();
		captureForkIds(manager);
		manager.newSession();
		forkInit(manager);
		record(manager, "Decision after fork at the very beginning.");
		expect(readSessionMemory(manager).root?.id).toBe("o4");
	});

	it("enforces one writer and permanently blocks an uncertain in-memory append until reopening", () => {
		const manager = persisted();
		record(manager, "First decision.");
		const owner = writer(manager);
		expect(() => writer(SessionManager.open(manager.getSessionFile()!))).toThrow(/already has/);
		const data = proposal(manager, "Second decision.");
		expect(() => owner.append((type, value) => { manager.appendCustomEntry(type, value); throw new Error("failure after append"); }, OM_OBSERVATIONS_RECORDED, data)).toThrow(/uncertain/);
		expect(() => readSessionMemory(manager)).toThrow(/reopen/);
		owner.release();
		expect(() => writer(manager)).toThrow(/reopen/);
		owner.release();
		// A new manager reads the actually committed file and keeps all published numbers.
		const reopened = SessionManager.open(manager.getSessionFile()!);
		expect(readSessionMemory(reopened).allocation.highWater).toEqual({ observation: "2", segment: "1" });
	});

	it("handles Pi's actual memory-before-disk append failure without exposing or retrying it", () => {
		const manager = persisted();
		record(manager, "First decision.");
		const data = proposal(manager, "An unconfirmed decision.");
		const file = manager.getSessionFile()!;
		const backup = `${file}.backup`;
		renameSync(file, backup);
		mkdirSync(file); // appendFileSync now fails, after Pi has mutated its in-memory ledger.
		const owner = writer(manager);
		expect(() => owner.append((type, value) => manager.appendCustomEntry(type, value), OM_OBSERVATIONS_RECORDED, data)).toThrow(/reopen/);
		expect(manager.getEntries().at(-1)).toMatchObject({ customType: OM_OBSERVATIONS_RECORDED, data });
		expect(() => readSessionMemory(manager)).toThrow(/reopen/);
		expect(() => owner.append(() => { throw new Error("must not retry"); }, OM_OBSERVATIONS_RECORDED, data)).toThrow(/reopen/);
		rmSync(file, { recursive: true });
		renameSync(backup, file);
		owner.release();
		expect(readSessionMemory(SessionManager.open(file)).allocation.highWater.observation).toBe("1");
	});

	it("blocks an unconfirmed no-op append but allows a genuinely new Session scope", () => {
		const manager = SessionManager.inMemory("/ephemeral");
		const data = proposal(manager, "Unconfirmed decision.");
		const owner = writer(manager);
		expect(() => owner.append(() => {}, OM_OBSERVATIONS_RECORDED, data)).toThrow(/exactly one matching/);
		expect(() => readSessionMemory(manager)).toThrow(/reopen/);
		owner.release();
		manager.newSession();
		const fresh = writer(manager);
		const next = proposal(manager, "New Session decision.");
		fresh.append((type, value) => manager.appendCustomEntry(type, value), OM_OBSERVATIONS_RECORDED, next);
		expect(readSessionMemory(manager).root?.id).toBe("o1");
	});

	it("reserves committed numbers even if rendering later fails and supports Pi's deferred first flush", () => {
		const dir = mkdtempSync(join(tmpdir(), "om-deferred-"));
		directories.push(dir);
		const manager = SessionManager.create(dir, dir);
		const data = proposal(manager, "An early decision.");
		const owner = writer(manager);
		owner.append((type, value) => manager.appendCustomEntry(type, value), OM_OBSERVATIONS_RECORDED, data);
		expect(existsSync(manager.getSessionFile()!)).toBe(false);
		expect(() => renderMemoryTree(readSessionMemory(manager), -1)).toThrow();
		manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Acknowledged." }], timestamp: 2 } as any);
		expect(existsSync(manager.getSessionFile()!)).toBe(true);
		const reopened = SessionManager.open(manager.getSessionFile()!);
		expect(readSessionMemory(reopened).root?.id).toBe("o1");
		expect(proposal(reopened, "Next decision.").highWater).toEqual({ observation: "2", segment: "1" });
	});
});
