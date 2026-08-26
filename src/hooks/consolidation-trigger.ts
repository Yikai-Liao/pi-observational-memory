import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runObserver } from "../agents/observer/agent.js";
import { resolveObserverChunkMaxTokens } from "../config.js";
import { debugLog, withDebugLogContext } from "../debug-log.js";
import { MemoryTreeStore, applyObserverProposal } from "../memory-tree/store.js";
import { OM_OBSERVATIONS_RECORDED, type Entry, type MemoryTree } from "../memory-tree/types.js";
import {
	latestObservationCoverageId,
	rawTokensSinceObservationCoverage,
	realTokensSinceObservationAnchor,
	sourceEntriesAfterCoverage,
} from "../progress.js";
import type { ResolveResult, Runtime } from "../runtime.js";
import { serializeSourceAddressedBranchEntries } from "../serialize.js";

const store = new MemoryTreeStore();

type ObserverCtx = {
	cwd: string;
	hasUI: boolean;
	ui?: { notify: (message: string, type?: "warning" | "info" | "error") => void };
	model: unknown;
	modelRegistry: any;
	getContextUsage?: () => { tokens?: number | null; contextWindow?: number } | undefined;
	sessionManager: {
		getBranch: () => unknown;
		getSessionId?: () => string;
		getSessionFile?: () => string | undefined;
	};
};

type ObserverRunOptions = {
	forced: boolean;
	signal?: AbortSignal;
};

export type ObserverRunResult = {
	tree: MemoryTree;
	appended: boolean;
	warnings: string[];
};

type ResolvedModel = Extract<ResolveResult, { ok: true }>;

function sessionId(ctx: ObserverCtx): string | undefined {
	try {
		return ctx.sessionManager.getSessionId?.() ?? ctx.sessionManager.getSessionFile?.();
	} catch {
		return undefined;
	}
}

function currentContextTokens(ctx: ObserverCtx): number | undefined {
	const value = ctx.getContextUsage?.()?.tokens;
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function observationProgressTokens(entries: Entry[], ctx: ObserverCtx): number {
	const current = currentContextTokens(ctx);
	const real = current === undefined ? undefined : realTokensSinceObservationAnchor(entries, current);
	return real ?? rawTokensSinceObservationCoverage(entries);
}

function observationDue(entries: Entry[], runtime: Runtime, ctx: ObserverCtx): boolean {
	const tokens = observationProgressTokens(entries, ctx);
	if (tokens < runtime.config.observeAfterTokens) return false;
	const backoff = runtime.observerEmptyBackoff;
	if (!backoff) return true;
	if (
		sessionId(ctx) !== backoff.sessionIdentity
		|| latestObservationCoverageId(entries) !== backoff.coverageId
		|| tokens >= backoff.tokensAtEmpty + runtime.config.observeAfterTokens
	) {
		runtime.observerEmptyBackoff = undefined;
		return true;
	}
	debugLog("observer.empty_backoff", { tokens, resumeAtTokens: backoff.tokensAtEmpty + runtime.config.observeAfterTokens });
	return false;
}

async function resolveObserverModel(runtime: Runtime, ctx: ObserverCtx): Promise<ResolvedModel> {
	const resolved = await runtime.resolveModel({ model: ctx.model, modelRegistry: ctx.modelRegistry, hasUI: ctx.hasUI, ui: ctx.ui });
	if (!resolved.ok) throw new Error(resolved.reason);
	return resolved;
}

function notify(runtime: Runtime, ctx: ObserverCtx, message: string, type: "warning" | "info" = "info"): void {
	if (ctx.hasUI && (type === "warning" || runtime.config.showWorkerNotifications)) ctx.ui?.notify(message, type);
}

export async function runObserverOnce(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ObserverCtx,
	options: ObserverRunOptions,
): Promise<ObserverRunResult> {
	return runtime.enqueueObserver(async () => {
		const signal = options.signal ? AbortSignal.any([options.signal, runtime.sessionAbort.signal]) : runtime.sessionAbort.signal;
		signal.throwIfAborted();
		const expectedSessionId = runtime.sessionId;
		const expectedGeneration = runtime.branchGeneration;
		if (sessionId(ctx) !== expectedSessionId) throw new Error("session changed before Observer started");

		const initialEntries = ctx.sessionManager.getBranch() as Entry[];
		const initialTree = store.rebuild(initialEntries);
		const initialCoverageId = latestObservationCoverageId(initialEntries);
		const initialTokens = observationProgressTokens(initialEntries, ctx);
		const pending = sourceEntriesAfterCoverage(initialEntries);
		if (pending.length === 0 && !options.forced) return { tree: initialTree, appended: false, warnings: [] };
		if (pending.length === 0 && !initialTree.root) return { tree: initialTree, appended: false, warnings: [] };

		const resolved = await resolveObserverModel(runtime, ctx);
		const maxTokens = options.forced
			? undefined
			: resolveObserverChunkMaxTokens(runtime.config, (resolved.model as { contextWindow?: number }).contextWindow);
		const serialized = serializeSourceAddressedBranchEntries(pending, maxTokens === undefined ? {} : { maxTokens });
		if (pending.length > 0 && serialized.sourceEntryIds.length === 0) throw new Error("pending source could not be serialized");
		const coversUpToId = serialized.sourceEntryIds.at(-1);
		const segmentRequired = options.forced
			|| initialTree.observationBatchesSinceSegmentation + 1 >= runtime.config.segmentEveryObserverRuns;

		notify(runtime, ctx, `Observational memory: Observer running${options.forced ? " for compaction" : ""} on ~${serialized.estimatedTokens.toLocaleString()} tokens`);
		debugLog("observer.start", {
			forced: options.forced,
			segmentRequired,
			sourceEntryCount: serialized.sourceEntryIds.length,
			chunkTokens: serialized.estimatedTokens,
			generation: expectedGeneration,
		});
		const output = await runObserver({
			model: resolved.model as any,
			apiKey: resolved.apiKey,
			headers: resolved.headers,
			env: resolved.env,
			baseUrl: resolved.baseUrl,
			tree: initialTree,
			chunk: serialized.text,
			segmentRequired,
			successfulBatches: initialTree.observationBatchesSinceSegmentation,
			signal,
			thinkingLevel: runtime.config.model?.thinking,
		});

		signal.throwIfAborted();
		if (runtime.sessionId !== expectedSessionId || runtime.branchGeneration !== expectedGeneration || sessionId(ctx) !== expectedSessionId) {
			throw new Error("session or branch changed while Observer was running");
		}
		const currentEntries = ctx.sessionManager.getBranch() as Entry[];
		const currentTree = store.rebuild(currentEntries);
		const sourceIds = new Set(currentEntries.map((entry) => entry.id));
		if (serialized.sourceEntryIds.some((id) => !sourceIds.has(id))) throw new Error("Observer source is no longer on the active branch");

		const normalized = applyObserverProposal(currentTree, output.tree, currentEntries, {
			allowedSourceEntryIds: serialized.sourceEntryIds,
			coversUpToId,
			segmentRequested: segmentRequired,
		});
		if (output.tree && !normalized.data) throw new Error(`Observer proposal rejected: ${normalized.warnings.join("; ") || "invalid tree"}`);
		for (const warning of normalized.warnings) notify(runtime, ctx, `Observational memory: ${warning}`, "warning");
		const recordedObservation = normalized.data?.nodeRecords.some((record) => !("childIds" in record)) ?? false;
		if (recordedObservation) runtime.observerEmptyBackoff = undefined;
		else if (!options.forced) runtime.observerEmptyBackoff = {
			sessionIdentity: expectedSessionId,
			coverageId: initialCoverageId,
			tokensAtEmpty: initialTokens,
		};
		if (!normalized.data) {
			debugLog("observer.empty", { forced: options.forced, coversUpToId });
			return { tree: currentTree, appended: false, warnings: normalized.warnings };
		}

		pi.appendEntry(OM_OBSERVATIONS_RECORDED, normalized.data);
		debugLog("observer.recorded", {
			recordCount: normalized.data.nodeRecords.length,
			observationCount: normalized.data.nodeRecords.filter((record) => !("childIds" in record)).length,
			segmentCheck: normalized.data.segmentCheck,
			warningCount: normalized.warnings.length,
			coversUpToId,
		});
		notify(runtime, ctx, `Observational memory: recorded ${normalized.data.nodeRecords.length} tree node record${normalized.data.nodeRecords.length === 1 ? "" : "s"}`);
		return { tree: normalized.tree, appended: true, warnings: normalized.warnings };
	});
}

export function registerConsolidationTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("session_start", (_event, ctx) => {
		runtime.ensureConfig(ctx.cwd);
		runtime.beginSession(ctx.sessionManager.getSessionId?.());
		try {
			store.rebuild(ctx.sessionManager.getBranch() as Entry[]);
			debugLog("tree.rebuilt", { reason: "session_start" });
		} catch (error) {
			runtime.lastObserverError = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI) ctx.ui.notify(`Observational memory: tree rebuild failed: ${runtime.lastObserverError}`, "warning");
			debugLog("tree.rebuild_failed", { reason: "session_start", errorMessage: runtime.lastObserverError });
		}
	});
	pi.on("session_tree", (_event, ctx) => {
		runtime.invalidateBranch();
		try {
			store.rebuild(ctx.sessionManager.getBranch() as Entry[]);
			debugLog("tree.rebuilt", { reason: "session_tree" });
		} catch (error) {
			runtime.lastObserverError = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI) ctx.ui.notify(`Observational memory: tree rebuild failed: ${runtime.lastObserverError}`, "warning");
		}
	});
	pi.on("session_shutdown", () => runtime.shutdownSession());

	const launch = (_event: unknown, ctx: ObserverCtx) => {
		runtime.ensureConfig(ctx.cwd);
		if (runtime.config.passive || runtime.consolidationInFlight) return;
		const entries = ctx.sessionManager.getBranch() as Entry[];
		if (!observationDue(entries, runtime, ctx)) return;
		const runId = `observer-${Date.now().toString(36)}`;
		void runtime.launchConsolidationTask(ctx, async () => withDebugLogContext({
			enabled: runtime.config.debugLog,
			cwd: ctx.cwd,
			sessionId: sessionId(ctx),
			runId,
		}, async () => {
			try {
				await runObserverOnce(pi, runtime, ctx, { forced: false });
			} catch (error) {
				debugLog("observer.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "observer", error) });
			}
		}));
	};
	pi.on("agent_start", launch);
	pi.on("turn_end", launch);
}
