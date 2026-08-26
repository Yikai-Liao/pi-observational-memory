import { describe, expect, it } from "vitest";
import { OM_OBSERVATIONS_RECORDED, type Entry } from "../src/memory-tree/types.js";
import { latestObservationCoverageIndex, rawTokensSinceObservationCoverage, sourceEntriesAfterCoverage } from "../src/progress.js";

const raw = (id: string, text = "source text"): Entry => ({ type: "custom_message", id, content: text });

describe("V4 observation coverage", () => {
	it("advances only for valid events with new Observations", () => {
		const observation = { id: "aaaaaaaaaaaa", content: "A durable source-backed observation.", sourceEntryIds: ["raw-a"] };
		const entries: Entry[] = [
			raw("raw-a"),
			{ type: "custom", id: "observed", customType: OM_OBSERVATIONS_RECORDED, data: { version: 1, nodeRecords: [observation], coversUpToId: "raw-a", segmentCheck: "not_requested" } },
			raw("raw-b"),
			{ type: "custom", id: "segmented", customType: OM_OBSERVATIONS_RECORDED, data: { version: 1, nodeRecords: [], segmentCheck: "complete" } },
			raw("raw-c"),
		];
		expect(latestObservationCoverageIndex(entries)).toBe(0);
		expect(sourceEntriesAfterCoverage(entries).map((entry) => entry.id)).toEqual(["raw-b", "raw-c"]);
		expect(rawTokensSinceObservationCoverage(entries)).toBe(6); // raw-b + raw-c
	});
});
