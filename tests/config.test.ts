import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULTS, loadConfig, readEnvConfig, resolveCompactAfterTokens, resolveObserverChunkMaxTokens } from "../src/config.js";

vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => "/tmp/no-global-settings" }));

describe("V4 config", () => {
	it("uses Segment Memory defaults", () => {
		expect(DEFAULTS).toMatchObject({ segmentEveryObserverRuns: 2, memoryDepth: 2 });
		expect(DEFAULTS).not.toHaveProperty("reflectAfterTokens");
		expect(DEFAULTS).not.toHaveProperty("observationsPoolMaxTokens");
	});

	it("accepts zero memoryDepth and positive cadence", () => {
		const project = mkdtempSync(join(tmpdir(), "om-config-"));
		mkdirSync(join(project, ".pi"));
		writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ "observational-memory": { memoryDepth: 0, segmentEveryObserverRuns: 3, reflectAfterTokens: 1 } }));
		const config = loadConfig(project, {});
		expect(config.memoryDepth).toBe(0);
		expect(config.segmentEveryObserverRuns).toBe(3);
		expect(config).not.toHaveProperty("reflectAfterTokens");
	});

	it("keeps passive env parsing", () => {
		expect(readEnvConfig({ PI_OBSERVATIONAL_MEMORY_PASSIVE: "yes" })).toEqual({ passive: true });
		expect(readEnvConfig({ PI_OBSERVATIONAL_MEMORY_PASSIVE: "off" })).toEqual({ passive: false });
	});

	it("resolves compact and observer thresholds", () => {
		expect(resolveCompactAfterTokens({ ...DEFAULTS, compactAfterTokensMode: "ratio", compactAfterTokensRatio: 0.5 }, 1000)).toBe(500);
		expect(resolveCompactAfterTokens(DEFAULTS, undefined)).toBe(DEFAULTS.compactAfterTokens);
		expect(resolveObserverChunkMaxTokens({ ...DEFAULTS, observerChunkMaxTokens: 100 }, 1000)).toBe(256);
		expect(resolveObserverChunkMaxTokens(DEFAULTS, 10_000)).toBe(2_000);
	});
});
