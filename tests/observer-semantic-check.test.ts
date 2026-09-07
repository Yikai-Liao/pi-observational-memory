import { describe, expect, it } from "vitest";
import { checkObservationMeaning } from "../eval/observer-semantic-check.mjs";

const requirements = [{ id: "exact-location", description: "Each agent gets one exact notes path." }, { id: "clean-worktree", description: "The reviewed tree stays clean." }];
const checks = [
	{ id: "exact-location", passed: true, reason: "One explicit path per agent is preserved." },
	{ id: "clean-worktree", passed: false, reason: "Cleanliness is omitted." },
];
const response = (checks: unknown) => ({ output: [{ type: "function_call", name: "grade_memory", arguments: JSON.stringify({ checks }) }] });
const input = { source: "Give each agent one notes path; keep the tree clean.", content: "Give each agent one explicit scratch-notes path.", requirements };

describe("Observer semantic grading boundary", () => {
	it("preserves a negative verdict and sends source, candidate and independent requirements", async () => {
		let sent: any;
		const result = await checkObservationMeaning({ ...input, request: async (body: unknown) => { sent = body; return response([...checks].reverse()); } });
		expect(JSON.parse(sent.input[1].content[0].text)).toEqual({ source: input.source, candidate: input.content, requirements });
		expect(result.find((check: any) => check.id === "clean-worktree").passed).toBe(false);
	});

	// These test the untrusted API boundary, not the grader's understanding.
	// Actual semantic accuracy is checked by live probes in observer-cases.json.
	it.each([
		["missing requirement", [checks[0]]],
		["duplicate requirement", [checks[0], checks[0]]],
		["unknown requirement", [checks[0], { ...checks[1], id: "unknown" }]],
		["string boolean", [checks[0], { ...checks[1], passed: "false" }]],
		["empty explanation", [checks[0], { ...checks[1], reason: "" }]],
	])("rejects %s instead of accepting a partial verdict", async (_label, invalid) => {
		await expect(checkObservationMeaning({ ...input, request: async () => response(invalid) })).rejects.toThrow("incomplete or malformed");
	});

	it("rejects prose without the required grading call", async () => {
		await expect(checkObservationMeaning({ ...input, request: async () => ({ output: [] }) })).rejects.toThrow("exactly once");
	});
});
