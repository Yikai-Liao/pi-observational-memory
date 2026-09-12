import { recorded } from "./fixtures/node-records.js";
import { describe, expect, it } from "vitest";
import { OM_OBSERVATIONS_RECORDED, type Entry } from "../src/memory-tree/types.js";
import { latestObservationCoverageIndex, rawTokensSinceLastCompaction, rawTokensSinceObservationCoverage, sourceEntriesAfterCoverage } from "../src/progress.js";

const raw = (id: string, text = "source text"): Entry => ({ type: "custom_message", id, content: text });

describe("V4 observation coverage", () => {
	it("ignores malformed events and coverage markers outside the branch", () => {
		const observation = { id: "o1", content: "A durable source-backed observation.", sourceEntryIds: ["raw-a"] };
		const entries: Entry[] = [
			raw("raw-a"),
			{ type: "custom", id: "observed", customType: OM_OBSERVATIONS_RECORDED, data: recorded({ nodeRecords: [observation], coversUpToId: "raw-a", segmentCheck: "not_requested" }) },
			raw("raw-b"),
			{ type: "custom", id: "malformed", customType: OM_OBSERVATIONS_RECORDED, data: recorded({ nodeRecords: [], segmentCheck: "not_requested" }) },
			{ type: "custom", id: "missing-coverage", customType: OM_OBSERVATIONS_RECORDED, data: recorded({ nodeRecords: [observation], coversUpToId: "not-on-branch", segmentCheck: "not_requested" }) },
		];
		expect(latestObservationCoverageIndex(entries)).toBe(0);
		expect(sourceEntriesAfterCoverage(entries).map((entry) => entry.id)).toEqual(["raw-b"]);
	});

	it("counts source entries after a compaction with no retention boundary", () => {
		const entries: Entry[] = [
			{ type: "compaction", id: "compact" },
			raw("raw-a", "aaaa"),
			raw("raw-b", "bbbb"),
		];
		expect(rawTokensSinceLastCompaction(entries)).toBe(2);
	});

	it("advances only for valid events with new Observations", () => {
		const observation = { id: "o1", content: "A durable source-backed observation.", sourceEntryIds: ["raw-a"] };
		const entries: Entry[] = [
			raw("raw-a"),
			{ type: "custom", id: "observed", customType: OM_OBSERVATIONS_RECORDED, data: recorded({ nodeRecords: [observation], coversUpToId: "raw-a", segmentCheck: "not_requested" }) },
			raw("raw-b"),
			{ type: "custom", id: "segmented", customType: OM_OBSERVATIONS_RECORDED, data: recorded({ nodeRecords: [], segmentCheck: "complete" }) },
			raw("raw-c"),
		];
		expect(latestObservationCoverageIndex(entries)).toBe(0);
		expect(sourceEntriesAfterCoverage(entries).map((entry) => entry.id)).toEqual(["raw-b", "raw-c"]);
		expect(rawTokensSinceObservationCoverage(entries)).toBe(6); // raw-b + raw-c
	});
});
