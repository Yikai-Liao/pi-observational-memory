import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ConfiguredModel {
	provider: string;
	id: string;
	thinking?: ModelThinkingLevel;
}

export type CompactAfterTokensMode = "calibrated" | "ratio";

export interface Config {
	observeAfterTokens: number;
	observerChunkMaxTokens?: number;
	segmentEveryObserverRuns: number;
	compactAfterTokens: number;
	compactAfterTokensMode: CompactAfterTokensMode;
	compactAfterTokensRatio: number;
	memoryDepth: number;
	model?: ConfiguredModel;
	showWorkerNotifications: boolean;
	passive: boolean;
	debugLog: boolean;
}

export const DEFAULTS: Config = {
	observeAfterTokens: 10_000,
	segmentEveryObserverRuns: 2,
	compactAfterTokens: 81_000,
	compactAfterTokensMode: "calibrated",
	compactAfterTokensRatio: 0.68,
	memoryDepth: 2,
	showWorkerNotifications: true,
	passive: false,
	debugLog: false,
};

export const OBSERVER_CHUNK_FALLBACK_MAX_TOKENS = 60_000;
export const OBSERVER_CHUNK_MIN_TOKENS = 256;
export const OBSERVER_CHUNK_CONTEXT_RATIO = 0.2;
const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const SETTINGS_KEY = "observational-memory";
const PASSIVE_ENV = "PI_OBSERVATIONAL_MEMORY_PASSIVE";

export function resolveCompactAfterTokens(config: Config, contextWindow: number | undefined): number {
	return config.compactAfterTokensMode === "ratio" && typeof contextWindow === "number" && contextWindow > 0
		? Math.max(1, Math.floor(contextWindow * config.compactAfterTokensRatio))
		: config.compactAfterTokens;
}

export function resolveObserverChunkMaxTokens(config: Config, contextWindow: number | undefined): number {
	if (config.observerChunkMaxTokens !== undefined && config.observerChunkMaxTokens > 0) {
		return Math.max(OBSERVER_CHUNK_MIN_TOKENS, config.observerChunkMaxTokens);
	}
	return typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
		? Math.max(OBSERVER_CHUNK_MIN_TOKENS, Math.floor(contextWindow * OBSERVER_CHUNK_CONTEXT_RATIO))
		: OBSERVER_CHUNK_FALLBACK_MAX_TOKENS;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function normalizeModel(value: unknown): ConfiguredModel | undefined {
	if (!record(value) || typeof value.provider !== "string" || !value.provider || typeof value.id !== "string" || !value.id) return undefined;
	return {
		provider: value.provider,
		id: value.id,
		...(typeof value.thinking === "string" && THINKING_LEVELS.includes(value.thinking as ModelThinkingLevel)
			? { thinking: value.thinking as ModelThinkingLevel }
			: {}),
	};
}

function normalize(value: unknown): Partial<Config> {
	if (!record(value)) return {};
	const result: Partial<Config> = {};
	for (const key of ["observeAfterTokens", "observerChunkMaxTokens", "segmentEveryObserverRuns", "compactAfterTokens"] as const) {
		const parsed = positiveInteger(value[key]);
		if (parsed !== undefined) result[key] = parsed;
	}
	const memoryDepth = nonNegativeInteger(value.memoryDepth);
	if (memoryDepth !== undefined) result.memoryDepth = memoryDepth;
	if (value.compactAfterTokensMode === "calibrated" || value.compactAfterTokensMode === "ratio") result.compactAfterTokensMode = value.compactAfterTokensMode;
	if (typeof value.compactAfterTokensRatio === "number" && Number.isFinite(value.compactAfterTokensRatio) && value.compactAfterTokensRatio > 0 && value.compactAfterTokensRatio < 1) result.compactAfterTokensRatio = value.compactAfterTokensRatio;
	for (const key of ["showWorkerNotifications", "passive", "debugLog"] as const) if (typeof value[key] === "boolean") result[key] = value[key];
	const model = normalizeModel(value.model);
	if (model) result.model = model;
	return result;
}

function readSettings(path: string): Partial<Config> {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		return normalize(parsed[SETTINGS_KEY]);
	} catch {
		return {};
	}
}

export function readEnvConfig(env: NodeJS.ProcessEnv = process.env): Partial<Config> {
	const value = env[PASSIVE_ENV]?.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(value ?? "")) return { passive: true };
	if (["0", "false", "no", "off"].includes(value ?? "")) return { passive: false };
	return {};
}

export function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): Config {
	return {
		...DEFAULTS,
		...readSettings(join(getAgentDir(), "settings.json")),
		...readSettings(join(cwd, ".pi", "settings.json")),
		...readEnvConfig(env),
	};
}
