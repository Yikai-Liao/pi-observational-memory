import { emptyAllocation, highWaterAfter } from "../src/memory-tree/allocation.ts";

/** Evaluation seeds are synthetic inputs, not a migration path for persisted Sessions. */
export function fixtureAllocation(nodes, previous = emptyAllocation()) {
	return {
		highWater: highWaterAfter(previous, nodes),
		birthEntryById: new Map([...previous.birthEntryById, ...nodes.map((node) => [node.id, "fixture"])]),
	};
}

export function replaceFixtureIds(value, ids) {
	if (typeof value === "string") return ids.get(value) ?? value;
	if (Array.isArray(value)) return value.map((item) => replaceFixtureIds(item, ids));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceFixtureIds(item, ids)]));
	return value;
}

/** Keep the frozen V3 source fixture files intact; give synthetic V4 seeds short IDs. */
export function prepareHierarchyIds(fixture, sessions) {
	const observationMaps = new Map();
	for (const [name, session] of Object.entries(sessions)) {
		const ids = new Map(session.observations.map((node, index) => [node.id, `o${index + 1}`]));
		observationMaps.set(name, ids);
		session.observations = session.observations.map((node) => ({ ...node, id: ids.get(node.id) }));
	}
	fixture.cases = fixture.cases.map((test) => {
		const ids = new Map(observationMaps.get(test.session));
		let segment = 1;
		ids.set(test.input.rootId, "s1");
		const walk = (children) => {
			for (const child of children) if (child.segment) {
				ids.set(child.segment.id, `s${++segment}`);
				walk(child.segment.children);
			}
		};
		walk(test.input.children);
		return replaceFixtureIds(test, ids);
	});
}
