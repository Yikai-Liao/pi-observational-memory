import { randomBytes } from "node:crypto";
import { getNode, validObservationContent, validSegmentSummary, validSegmentTitle } from "./node.js";
import {
	isNodeRecord,
	isObservation,
	isObservationRecord,
	isObservationsRecordedData,
	isSegment,
	isSegmentRecord,
	OM_OBSERVATIONS_RECORDED,
	type Entry,
	type MemoryTree,
	type Node,
	type NodeId,
	type NodeProposal,
	type Observation,
	type ObservationsRecordedEntryData,
	type Segment,
	type SegmentId,
	type TreeDiagnostic,
} from "./types.js";

export class MemoryTreeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MemoryTreeError";
	}
}

export type ProposalResult = {
	data?: ObservationsRecordedEntryData;
	tree: MemoryTree;
	warnings: string[];
};

export type ApplyProposalOptions = {
	allowedSourceEntryIds: string[];
	coversUpToId?: string;
	segmentRequested: boolean;
	createObservationId?: () => string;
	createSegmentId?: () => SegmentId;
};

function emptyTree(): MemoryTree {
	return {
		observationsById: new Map(),
		segmentsById: new Map(),
		parentByChildId: new Map(),
		observationBatchesSinceSegmentation: 0,
		diagnostics: [],
	};
}

function cloneTree(tree: MemoryTree): MemoryTree {
	return {
		observationsById: new Map(tree.observationsById),
		segmentsById: new Map(tree.segmentsById),
		root: tree.root,
		parentByChildId: new Map(tree.parentByChildId),
		observationBatchesSinceSegmentation: tree.observationBatchesSinceSegmentation,
		diagnostics: [...tree.diagnostics],
	};
}

function uniqueId(prefix: "" | "s_", occupied: Set<string>): string {
	for (;;) {
		const id = `${prefix}${randomBytes(6).toString("hex")}`;
		if (!occupied.has(id)) {
			occupied.add(id);
			return id;
		}
	}
}

function sourceRanks(entries: Entry[]): Map<string, number> {
	return new Map(entries.map((entry, index) => [entry.id, index]));
}

function validateAndPublish(tree: MemoryTree, entries: Entry[], firstSeen: Map<NodeId, number>): MemoryTree {
	const nodeCount = tree.observationsById.size + tree.segmentsById.size;
	if (tree.observationsById.size === 0) {
		if (tree.segmentsById.size > 0) throw new MemoryTreeError("segments exist without observations");
		return { ...tree, root: undefined, parentByChildId: new Map() };
	}

	const parents = new Map<NodeId, SegmentId>();
	for (const segment of tree.segmentsById.values()) {
		if (segment.childIds.length < 2) throw new MemoryTreeError(`segment ${segment.id} has fewer than two children`);
		const direct = new Set<NodeId>();
		for (const childId of segment.childIds) {
			if (direct.has(childId)) throw new MemoryTreeError(`segment ${segment.id} repeats child ${childId}`);
			direct.add(childId);
			if (!getNode(tree, childId)) throw new MemoryTreeError(`segment ${segment.id} references missing child ${childId}`);
			if (parents.has(childId)) throw new MemoryTreeError(`node ${childId} has multiple parents`);
			parents.set(childId, segment.id);
		}
	}

	if (tree.observationsById.size >= 2 && tree.segmentsById.size === 0) {
		throw new MemoryTreeError("two or more observations require a Segment root");
	}
	const roots: Node[] = [];
	for (const node of [...tree.observationsById.values(), ...tree.segmentsById.values()]) {
		if (!parents.has(node.id)) roots.push(node);
	}
	if (roots.length !== 1) throw new MemoryTreeError(`expected one root, found ${roots.length}`);
	const root = roots[0]!;
	if (tree.observationsById.size === 1) {
		if (!isObservation(root) || tree.segmentsById.size !== 0) throw new MemoryTreeError("a single observation must be the only root");
	} else if (!isSegment(root)) {
		throw new MemoryTreeError("two or more observations require a Segment root");
	}

	const visiting = new Set<NodeId>();
	const visited = new Set<NodeId>();
	const leaves: Observation[] = [];
	const walk = (node: Node): void => {
		if (visiting.has(node.id)) throw new MemoryTreeError(`cycle detected at ${node.id}`);
		if (visited.has(node.id)) throw new MemoryTreeError(`node ${node.id} is reachable more than once`);
		visiting.add(node.id);
		if (isObservation(node)) {
			leaves.push(node);
		} else {
			for (const childId of node.childIds) walk(getNode(tree, childId)!);
		}
		visiting.delete(node.id);
		visited.add(node.id);
	};
	walk(root);
	if (visited.size !== nodeCount) throw new MemoryTreeError(`${nodeCount - visited.size} node(s) are unreachable from root`);

	const ranks = sourceRanks(entries);
	const expectedLeaves = [...tree.observationsById.values()].sort((a, b) => {
		const aRank = Math.min(...a.sourceEntryIds.map((id) => ranks.get(id) ?? Number.MAX_SAFE_INTEGER));
		const bRank = Math.min(...b.sourceEntryIds.map((id) => ranks.get(id) ?? Number.MAX_SAFE_INTEGER));
		return aRank - bRank || (firstSeen.get(a.id) ?? 0) - (firstSeen.get(b.id) ?? 0);
	});
	if (leaves.some((leaf, index) => leaf.id !== expectedLeaves[index]?.id)) {
		throw new MemoryTreeError("observation leaf order does not match source ledger order");
	}

	return { ...tree, root, parentByChildId: parents };
}

export class MemoryTreeStore {
	rebuild(entries: Entry[]): MemoryTree {
		let tree = emptyTree();
		const firstSeen = new Map<NodeId, number>();
		let seenCounter = 0;

		for (const entry of entries) {
			if (entry.type !== "custom" || entry.customType !== OM_OBSERVATIONS_RECORDED) continue;
			if (!isObservationsRecordedData(entry.data)) {
				throw new MemoryTreeError(`malformed ${OM_OBSERVATIONS_RECORDED} entry ${entry.id}`);
			}
			const candidate = cloneTree(tree);
			const idsInEvent = new Set<NodeId>();
			let newObservationCount = 0;
			for (const record of entry.data.nodeRecords) {
				if (!isNodeRecord(record)) throw new MemoryTreeError(`malformed node record in entry ${entry.id}`);
				if (idsInEvent.has(record.id)) throw new MemoryTreeError(`entry ${entry.id} repeats node record ${record.id}`);
				idsInEvent.add(record.id);
				const prior = getNode(candidate, record.id);
				if (prior && isSegment(prior) !== isSegment(record)) throw new MemoryTreeError(`node ${record.id} changed kind`);
				if (!firstSeen.has(record.id)) firstSeen.set(record.id, seenCounter++);
				if (isObservationRecord(record)) {
					if (prior) throw new MemoryTreeError(`observation ${record.id} cannot be updated`);
					candidate.observationsById.set(record.id, record);
					newObservationCount++;
				} else if (isSegmentRecord(record)) {
					candidate.segmentsById.set(record.id, record);
				}
			}
			candidate.diagnostics.push(...(entry.data.warnings ?? []).map((message): TreeDiagnostic => ({ level: "warning", message })));
			if (entry.data.segmentCheck === "complete") candidate.observationBatchesSinceSegmentation = 0;
			else if (entry.data.segmentCheck === "partial") {
				candidate.observationBatchesSinceSegmentation = Math.max(1, candidate.observationBatchesSinceSegmentation);
			} else if (newObservationCount > 0) candidate.observationBatchesSinceSegmentation++;
			tree = validateAndPublish(candidate, entries, firstSeen);
		}
		return validateAndPublish(tree, entries, firstSeen);
	}
}

function normalizeSourceIds(ids: unknown, allowed: string[]): string[] | undefined {
	if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === "string")) return undefined;
	const order = new Map(allowed.map((id, index) => [id, index]));
	if (ids.some((id) => !order.has(id))) return undefined;
	return [...new Set(ids)].sort((a, b) => order.get(a)! - order.get(b)!);
}

type ProposalOrder = readonly [sourcePosition: number, stablePosition: number];

type BuiltProposal = {
	id?: NodeId;
	order: ProposalOrder;
	records: Node[];
	consumed: NodeId[];
	newObservations: Observation[];
	promoted: BuiltProposal[];
};

function collectIds(tree: MemoryTree): Set<string> {
	return new Set([...tree.observationsById.keys(), ...tree.segmentsById.keys()]);
}

export function applyObserverProposal(
	base: MemoryTree,
	proposal: NodeProposal | null,
	entries: Entry[],
	options: ApplyProposalOptions,
): ProposalResult {
	const warnings: string[] = [];
	const occupied = collectIds(base);
	const rootChildren = isSegment(base.root) ? base.root.childIds : base.root ? [base.root.id] : [];
	const rootChildSet = new Set(rootChildren);
	const createObservationId = options.createObservationId ?? (() => uniqueId("", occupied));
	const createSegmentId = options.createSegmentId ?? (() => uniqueId("s_", occupied) as SegmentId);
	const sourcePositions = sourceRanks(entries);
	const compareOrder = (a: ProposalOrder, b: ProposalOrder): number => a[0] - b[0] || a[1] - b[1];
	const baseLeafPositions = new Map<NodeId, number>();
	let baseLeafPosition = 0;
	const indexBaseLeaves = (node: Node): void => {
		if (isObservation(node)) baseLeafPositions.set(node.id, baseLeafPosition++);
		else for (const id of node.childIds) indexBaseLeaves(getNode(base, id)!);
	};
	if (base.root) indexBaseLeaves(base.root);
	const baseOrder = (node: Node): ProposalOrder => isObservation(node)
		? [Math.min(...node.sourceEntryIds.map((id) => sourcePositions.get(id) ?? Number.MAX_SAFE_INTEGER)), baseLeafPositions.get(node.id)!]
		: node.childIds.map((id) => baseOrder(getNode(base, id)!)).sort(compareOrder)[0]!;
	let newObservationPosition = baseLeafPosition;
	const emptyBuilt = (): BuiltProposal => ({ order: [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER], records: [], consumed: [], newObservations: [], promoted: [] });

	const build = (value: NodeProposal, isTop = false): BuiltProposal => {
		if (!value || typeof value !== "object") {
			warnings.push("removed malformed node proposal");
			return emptyBuilt();
		}
		if (value.type === "ref") {
			const node = getNode(base, value.id);
			if (!node || !rootChildSet.has(value.id)) {
				warnings.push(`removed invalid existing-node reference ${value.id}`);
				return emptyBuilt();
			}
			return { id: value.id, order: baseOrder(node), records: [], consumed: [value.id], newObservations: [], promoted: [] };
		}
		if (value.type === "observation") {
			const sourceEntryIds = normalizeSourceIds(value.sourceEntryIds, options.allowedSourceEntryIds);
			if (!validObservationContent(value.content) || !sourceEntryIds) {
				warnings.push("removed invalid observation proposal");
				return emptyBuilt();
			}
			const observation: Observation = { id: createObservationId(), content: value.content.trim(), sourceEntryIds };
			occupied.add(observation.id);
			return {
				id: observation.id,
				order: [Math.min(...sourceEntryIds.map((id) => sourcePositions.get(id) ?? Number.MAX_SAFE_INTEGER)), newObservationPosition++],
				records: [observation],
				consumed: [],
				newObservations: [observation],
				promoted: [],
			};
		}
		if (value.type !== "segment" || !Array.isArray(value.children)) {
			warnings.push("removed malformed segment proposal");
			return emptyBuilt();
		}

		const builtChildren = value.children.map((child) => build(child));
		const flattened = builtChildren.flatMap((child) => child.id ? [child] : child.promoted).sort((a, b) => compareOrder(a.order, b.order));
		const order = flattened[0]?.order ?? [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
		const childIds = flattened.map((child) => child.id!).filter(Boolean);
		const records = flattened.flatMap((child) => child.records);
		const consumed = flattened.flatMap((child) => child.consumed);
		const newObservations = flattened.flatMap((child) => child.newObservations);
		const existing = value.id ? base.segmentsById.get(value.id) : undefined;
		const allowedExisting = value.id === undefined || (isTop && isSegment(base.root) && value.id === base.root.id);
		const title = validSegmentTitle(value.title) ? value.title.trim() : existing?.title;
		const summary = validSegmentSummary(value.summary) ? value.summary.trim() : existing?.summary;
		if (value.id && !allowedExisting) warnings.push(`rejected update to non-root Segment ${value.id}`);
		if (existing && !validSegmentTitle(value.title)) warnings.push(`kept existing title for ${existing.id}`);
		if (existing && !validSegmentSummary(value.summary)) warnings.push(`kept existing summary for ${existing.id}`);

		if (!allowedExisting || !title || !summary || (!existing && childIds.length < 2)) {
			warnings.push(`removed invalid Segment proposal${value.id ? ` ${value.id}` : ""}; promoted valid children`);
			return { order, records: [], consumed, newObservations, promoted: flattened };
		}

		if (existing) {
			return { id: existing.id, order, records, consumed, newObservations, promoted: flattened };
		}
		const segment: Segment = { id: createSegmentId(), title, summary, childIds };
		occupied.add(segment.id);
		return { id: segment.id, order, records: [...records, segment], consumed, newObservations, promoted: [] };
	};

	if (!proposal) {
		return eventResult(base, entries, [], [], warnings, options);
	}
	const built = build(proposal, true);
	const newObservations = built.newObservations;
	let records = built.records;
	let candidate = cloneTree(base);
	for (const record of records) {
		if (isObservation(record)) candidate.observationsById.set(record.id, record);
		else candidate.segmentsById.set(record.id, record);
	}

	try {
		if (!base.root) {
			if (!built.id) throw new MemoryTreeError("proposal did not produce a root");
		} else if (isObservation(base.root)) {
			if (!built.id || !records.some((record) => isSegment(record) && record.id === built.id)) {
				throw new MemoryTreeError("second observation requires a new Segment root");
			}
		} else {
			if (proposal.type !== "segment" || proposal.id !== base.root.id) throw new MemoryTreeError("proposal must update the current Root Segment");
			const replacements = built.promoted;
			const update = mergeRootChildren(base, replacements, warnings);
			const title = validSegmentTitle(proposal.title) ? proposal.title.trim() : base.root.title;
			const summary = validSegmentSummary(proposal.summary) ? proposal.summary.trim() : base.root.summary;
			const rootRecord: Segment = { id: base.root.id, title, summary, childIds: update };
			records = [...records.filter((record) => record.id !== rootRecord.id), rootRecord];
			candidate = cloneTree(base);
			for (const record of records) {
				if (isObservation(record)) candidate.observationsById.set(record.id, record);
				else candidate.segmentsById.set(record.id, record);
			}
		}
		const firstSeen = new Map<NodeId, number>();
		let index = 0;
		for (const node of [...base.observationsById.values(), ...base.segmentsById.values(), ...records]) {
			if (!firstSeen.has(node.id)) firstSeen.set(node.id, index++);
		}
		candidate = validateAndPublish(candidate, entries, firstSeen);
		return eventResult(candidate, entries, records, newObservations, warnings, options);
	} catch (error) {
		warnings.push(error instanceof Error ? error.message : String(error));
		if (!isSegment(base.root) || newObservations.length === 0) {
			return { tree: base, warnings };
		}
		const sourcePositions = new Map(entries.map((entry, position) => [entry.id, position]));
		const orderedObservations = [...newObservations].sort((a, b) =>
			Math.min(...a.sourceEntryIds.map((id) => sourcePositions.get(id) ?? Number.MAX_SAFE_INTEGER))
			- Math.min(...b.sourceEntryIds.map((id) => sourcePositions.get(id) ?? Number.MAX_SAFE_INTEGER)),
		);
		const root: Segment = { ...base.root, childIds: [...base.root.childIds, ...orderedObservations.map((item) => item.id)] };
		const fallbackRecords: Node[] = [...orderedObservations, root];
		const fallback = cloneTree(base);
		for (const observation of orderedObservations) fallback.observationsById.set(observation.id, observation);
		fallback.segmentsById.set(root.id, root);
		try {
			const firstSeen = new Map<NodeId, number>();
			let index = 0;
			for (const node of [...base.observationsById.values(), ...base.segmentsById.values(), ...fallbackRecords]) {
				if (!firstSeen.has(node.id)) firstSeen.set(node.id, index++);
			}
			const published = validateAndPublish(fallback, entries, firstSeen);
			warnings.push("rejected structural update; appended valid observations as Root children");
			return eventResult(published, entries, fallbackRecords, orderedObservations, warnings, options);
		} catch {
			return { tree: base, warnings };
		}
	}
}

function mergeRootChildren(base: MemoryTree, proposals: BuiltProposal[], warnings: string[]): NodeId[] {
	if (!isSegment(base.root)) return [];
	const root = base.root;
	const result = [...root.childIds];
	const consumed = new Set<NodeId>();
	for (const item of proposals) {
		if (!item.id || item.id === root.id) continue;
		if (item.consumed.length === 0) {
			result.push(item.id);
			continue;
		}
		const positions = item.consumed.map((id) => root.childIds.indexOf(id));
		if (positions.some((position) => position < 0) || positions.some((position, i) => i > 0 && position !== positions[i - 1]! + 1)) {
			warnings.push(`rejected non-contiguous Segment replacement for ${item.id}`);
			continue;
		}
		if (item.consumed.some((id) => consumed.has(id))) {
			warnings.push(`rejected overlapping Segment replacement for ${item.id}`);
			continue;
		}
		item.consumed.forEach((id) => consumed.add(id));
		const currentPositions = item.consumed.map((id) => result.indexOf(id)).filter((position) => position >= 0);
		if (currentPositions.length !== item.consumed.length) continue;
		result.splice(currentPositions[0]!, currentPositions.length, item.id);
	}
	return result;
}

function eventResult(
	tree: MemoryTree,
	_entries: Entry[],
	records: Node[],
	newObservations: Observation[],
	warnings: string[],
	options: ApplyProposalOptions,
): ProposalResult {
	const segmentCheck = options.segmentRequested ? (warnings.length > 0 ? "partial" : "complete") : "not_requested";
	if (newObservations.length === 0 && !options.segmentRequested) return { tree, warnings };
	if (newObservations.length > 0 && !options.coversUpToId) return { tree, warnings: [...warnings, "missing coverage marker"] };
	return {
		tree,
		warnings,
		data: {
			version: 1,
			nodeRecords: records,
			...(newObservations.length > 0 ? { coversUpToId: options.coversUpToId } : {}),
			segmentCheck,
			...(warnings.length > 0 ? { warnings } : {}),
		},
	};
}
