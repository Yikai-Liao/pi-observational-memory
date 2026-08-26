import { isObservationsRecordedData, OM_OBSERVATIONS_RECORDED, type Entry } from "./memory-tree/types.js";
import { estimateEntryTokens } from "./tokens.js";

const SOURCE_ENTRY_TYPES = new Set(["message", "custom_message", "branch_summary"]);

export function isSourceEntry(entry: Entry): boolean {
	return SOURCE_ENTRY_TYPES.has(entry.type);
}

export function latestObservationCoverageIndex(entries: Entry[]): number {
	const positions = new Map(entries.map((entry, index) => [entry.id, index]));
	let latest = -1;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== OM_OBSERVATIONS_RECORDED || !isObservationsRecordedData(entry.data)) continue;
		if (!entry.data.nodeRecords.some((record) => !("childIds" in record)) || !entry.data.coversUpToId) continue;
		const index = positions.get(entry.data.coversUpToId);
		if (index !== undefined) latest = Math.max(latest, index);
	}
	return latest;
}

export function latestObservationCoverageId(entries: Entry[]): string | undefined {
	const index = latestObservationCoverageIndex(entries);
	return index >= 0 ? entries[index]?.id : undefined;
}

export function sourceEntriesAfterCoverage(entries: Entry[]): Entry[] {
	return entries.slice(latestObservationCoverageIndex(entries) + 1).filter(isSourceEntry);
}

export function rawTokensAfterIndex(entries: Entry[], index: number): number {
	return entries.slice(index + 1).filter(isSourceEntry).reduce((sum, entry) => sum + estimateEntryTokens(entry), 0);
}

export function rawTokensSinceObservationCoverage(entries: Entry[]): number {
	return rawTokensAfterIndex(entries, latestObservationCoverageIndex(entries));
}

export function findLastCompactionIndex(entries: Entry[]): number {
	for (let index = entries.length - 1; index >= 0; index--) if (entries[index]?.type === "compaction") return index;
	return -1;
}

export function rawTokensSinceLastCompaction(entries: Entry[]): number {
	const compactionIndex = findLastCompactionIndex(entries);
	if (compactionIndex < 0) return rawTokensAfterIndex(entries, -1);
	const firstKept = entries[compactionIndex]?.firstKeptEntryId;
	const keptIndex = firstKept ? entries.findIndex((entry) => entry.id === firstKept) : -1;
	return rawTokensAfterIndex(entries, keptIndex < 0 ? compactionIndex : keptIndex - 1);
}

type UsageLike = { totalTokens?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number };

export function contextTokensFromUsage(usage: unknown): number | undefined {
	if (!usage || typeof usage !== "object") return undefined;
	const value = usage as UsageLike;
	if (typeof value.totalTokens === "number" && Number.isFinite(value.totalTokens) && value.totalTokens > 0) return value.totalTokens;
	const parts = [value.input, value.output, value.cacheRead, value.cacheWrite];
	if (!parts.every((part) => typeof part === "number" && Number.isFinite(part))) return undefined;
	const total = parts.reduce<number>((sum, part) => sum + (part ?? 0), 0);
	return total > 0 ? total : undefined;
}

function assistantContextTokens(entry: Entry): number | undefined {
	if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") return undefined;
	const message = entry.message as { role?: string; stopReason?: string; usage?: unknown };
	if (message.role !== "assistant" || message.stopReason === "aborted" || message.stopReason === "error") return undefined;
	return contextTokensFromUsage(message.usage);
}

export function realTokensSinceObservationAnchor(entries: Entry[], currentContextTokens: number): number | undefined {
	const coverageIndex = latestObservationCoverageIndex(entries);
	const compactionIndex = findLastCompactionIndex(entries);
	if (compactionIndex > coverageIndex) {
		for (let index = compactionIndex + 1; index < entries.length; index++) {
			const baseline = assistantContextTokens(entries[index]!);
			if (baseline !== undefined) return currentContextTokens >= baseline ? currentContextTokens - baseline : undefined;
		}
		return undefined;
	}
	if (coverageIndex >= 0) {
		for (let index = coverageIndex; index >= 0; index--) {
			const baseline = assistantContextTokens(entries[index]!);
			if (baseline !== undefined) return currentContextTokens >= baseline ? currentContextTokens - baseline : undefined;
		}
		return undefined;
	}
	return Math.max(0, currentContextTokens);
}
