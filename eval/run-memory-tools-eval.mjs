import { Value } from "typebox/value";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { normalizeOmReadArguments, OM_READ_DESCRIPTION, OM_READ_GUIDELINE, OM_READ_SCHEMA } from "../src/tools/om-read.ts";
import { normalizeOmSessionsArguments, OM_SESSIONS_DESCRIPTION, OM_SESSIONS_GUIDELINE, OM_SESSIONS_SCHEMA } from "../src/tools/om-sessions.ts";

const endpoint = process.env.EVAL_ENDPOINT;
const model = process.env.EVAL_MODEL;
const apiKey = process.env.API_KEY;
const reasoning = process.env.EVAL_REASONING;
const reportPath = process.env.EVAL_REPORT;
if (!process.env.EVAL_VALIDATE_ONLY && (!endpoint || !model || !apiKey || !reasoning)) throw new Error("Set EVAL_ENDPOINT, EVAL_MODEL, EVAL_REASONING, and API_KEY");

const cases = JSON.parse(await readFile(new URL("./memory-tool-cases.json", import.meta.url), "utf8"));
const tools = [
	{
		type: "function",
		name: "om_sessions",
		description: OM_SESSIONS_DESCRIPTION,
		parameters: OM_SESSIONS_SCHEMA,
	},
	{
		type: "function",
		name: "om_read",
		description: OM_READ_DESCRIPTION,
		parameters: OM_READ_SCHEMA,
	},
];

function same(expected, actual, key) {
	if (key === "keywords" && Array.isArray(expected) && Array.isArray(actual)) {
		return [...expected].map(String).map((item) => item.toLowerCase()).sort().join("|") === [...actual].map(String).map((item) => item.toLowerCase()).sort().join("|");
	}
	return JSON.stringify(expected) === JSON.stringify(actual);
}

async function post(body) {
	try {
		return await fetch(`${endpoint.replace(/\/$/, "")}/responses`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
	} catch {
		return fetch(`${endpoint.replace(/\/$/, "")}/responses`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
	}
}

async function run(test) {
	const response = await post({
			model,
			reasoning: { effort: reasoning },
			input: [
				{ role: "system", content: [{ type: "input_text", text: `Use exactly one provided memory tool that directly fulfills the user's request. Do not answer in prose.\n- ${OM_SESSIONS_GUIDELINE}\n- ${OM_READ_GUIDELINE}` }] },
				{ role: "user", content: [{ type: "input_text", text: test.request }] },
			],
			tools,
			tool_choice: "required",
		});
	const payload = await response.json();
	if (!response.ok) return { name: test.name, passed: false, failures: [`HTTP ${response.status}: ${payload.error?.message ?? JSON.stringify(payload)}`] };
	const calls = (payload.output ?? []).filter((item) => item.type === "function_call");
	const failures = [];
	if (calls.length !== 1) failures.push(`expected exactly one tool call, got ${calls.length}`);
	if (calls[0]?.name !== test.tool) failures.push(`expected ${test.tool}, got ${calls[0]?.name ?? "none"}`);
	let args = {};
	try {
		const rawArgs = JSON.parse(calls[0]?.arguments ?? "{}");
		args = (calls[0]?.name === "om_read" ? normalizeOmReadArguments(rawArgs) : normalizeOmSessionsArguments(rawArgs)) ?? {};
	} catch { failures.push("tool arguments are not JSON"); }
	for (const [key, value] of Object.entries(test.args)) if (!same(value, args[key], key)) failures.push(`expected ${key}=${JSON.stringify(value)}, got ${JSON.stringify(args[key])}`);
	for (const key of test.absent ?? []) if (key in args) failures.push(`expected ${key} to be omitted`);
	return { name: test.name, passed: failures.length === 0, failures, call: { name: calls[0]?.name, arguments: args } };
}

if (process.env.EVAL_VALIDATE_ONLY) {
  for (const test of cases) {
    const schema = test.tool === "om_read" ? OM_READ_SCHEMA : OM_SESSIONS_SCHEMA;
    if (!Value.Check(schema, test.args)) throw new Error(`Invalid expected arguments: ${test.name}`);
  }
  console.log(`Validated ${cases.length} memory-tool fixtures against production schemas; no model requests.`);
  process.exit(0);
}

const results = await Promise.all(cases.map(run));
const passed = results.filter((result) => result.passed).length;
const report = { model, reasoning, passed, total: results.length, score: passed / results.length * 100, results };
const serialized = JSON.stringify(report, null, 2);
if (reportPath) await writeFile(resolve(reportPath), serialized);
console.log(serialized);
if (passed !== results.length) process.exitCode = 1;
