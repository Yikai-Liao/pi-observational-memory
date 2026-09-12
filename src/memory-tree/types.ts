export const OM_OBSERVATIONS_RECORDED = "om.observations.recorded";
export const OM_NODE_IDS_INHERITED = "om.node-ids.inherited";
export const SEGMENT_RENDERED_DETAILS = "om.segment-tree.rendered";

export const OBSERVATION_ID_PATTERN = /^o[1-9][0-9]*$/;
export const SEGMENT_ID_PATTERN = /^s[1-9][0-9]*$/;

export type SegmentId = `s${string}`;
export type NodeId = string;

export type NodeHighWater = { segment: string; observation: string };
export type NodeAllocation = {
	highWater: NodeHighWater;
	birthEntryById: Map<NodeId, string>;
};
export type NodeIdsInheritedData = {
	version: 1;
	sessionId: string;
	sourceSessionId: string;
	highWater: NodeHighWater;
};

export type Observation = {
	id: string;
	content: string;
	sourceEntryIds: string[];
};

export type Segment = {
	id: SegmentId;
	title: string;
	summary: string;
	childIds: NodeId[];
};

export type Node = Observation | Segment;
export type SegmentCheck = "not_requested" | "complete" | "partial";

export type ObservationsRecordedEntryData = {
	version: 2;
	nodeRecords: Node[];
	highWater: NodeHighWater;
	coversUpToId?: string;
	segmentCheck: SegmentCheck;
	warnings?: string[];
};

export type SegmentMemoryDetails = {
	type: typeof SEGMENT_RENDERED_DETAILS;
	version: 2;
	memoryDepth: number;
	renderedNodeIds: NodeId[];
	exposedRefs: NodeId[];
};

export type RefProposal = { type: "ref"; id: NodeId };
export type ObservationProposal = {
	type: "observation";
	content: string;
	sourceEntryIds: string[];
};
export type SegmentProposal = {
	type: "segment";
	id?: SegmentId;
	title: string;
	summary: string;
	children: NodeProposal[];
};
export type NodeProposal = RefProposal | ObservationProposal | SegmentProposal;
export type ObserverOutput = { tree: NodeProposal | null };

export type TreeDiagnostic = {
	level: "warning" | "error";
	message: string;
};

export type MemoryTree = {
	allocation: NodeAllocation;
	observationsById: Map<string, Observation>;
	segmentsById: Map<SegmentId, Segment>;
	root?: Node;
	parentByChildId: Map<NodeId, SegmentId>;
	observationBatchesSinceSegmentation: number;
	diagnostics: TreeDiagnostic[];
};

export type Entry = {
	type: string;
	id: string;
	parentId?: string | null;
	timestamp?: string;
	message?: unknown;
	content?: unknown;
	customType?: string;
	summary?: unknown;
	fromId?: string;
	data?: unknown;
	details?: unknown;
	firstKeptEntryId?: string;
};

export function isSegment(node: Node | undefined): node is Segment {
	return !!node && "childIds" in node;
}

export function isObservation(node: Node | undefined): node is Observation {
	return !!node && !isSegment(node);
}

export function isNodeId(value: unknown): value is NodeId {
	return typeof value === "string" && value === value.trim()
		&& (OBSERVATION_ID_PATTERN.test(value) || SEGMENT_ID_PATTERN.test(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptySingleLine(value: unknown): value is string {
	return typeof value === "string" && value === value.trim() && value.length > 0 && !/[\r\n]/.test(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

export function isNodeHighWater(value: unknown): value is NodeHighWater {
	return isRecord(value) && hasOnlyKeys(value, ["segment", "observation"])
		&& typeof value.segment === "string" && value.segment === value.segment.trim() && /^(0|[1-9][0-9]*)$/.test(value.segment)
		&& typeof value.observation === "string" && value.observation === value.observation.trim() && /^(0|[1-9][0-9]*)$/.test(value.observation);
}

export function isNodeIdsInheritedData(value: unknown): value is NodeIdsInheritedData {
	return isRecord(value) && hasOnlyKeys(value, ["version", "sessionId", "sourceSessionId", "highWater"])
		&& value.version === 1 && isNonEmptySingleLine(value.sessionId)
		&& isNonEmptySingleLine(value.sourceSessionId) && value.sessionId !== value.sourceSessionId
		&& isNodeHighWater(value.highWater);
}

export function isObservationRecord(value: unknown): value is Observation {
	if (!isRecord(value)) return false;
	return hasOnlyKeys(value, ["id", "content", "sourceEntryIds"])
		&& isNodeId(value.id) && OBSERVATION_ID_PATTERN.test(value.id)
		&& isNonEmptySingleLine(value.content)
		&& Array.isArray(value.sourceEntryIds)
		&& value.sourceEntryIds.length > 0
		&& value.sourceEntryIds.every(isNonEmptySingleLine)
		&& new Set(value.sourceEntryIds).size === value.sourceEntryIds.length;
}

export function isSegmentRecord(value: unknown): value is Segment {
	if (!isRecord(value)) return false;
	return hasOnlyKeys(value, ["id", "title", "summary", "childIds"])
		&& isNodeId(value.id) && SEGMENT_ID_PATTERN.test(value.id)
		&& isNonEmptySingleLine(value.title)
		&& value.title.length <= 120
		&& isNonEmptySingleLine(value.summary)
		&& value.summary.length <= 2000
		&& Array.isArray(value.childIds)
		&& value.childIds.length >= 2
		&& value.childIds.every(isNodeId);
}

export function isNodeRecord(value: unknown): value is Node {
	return isObservationRecord(value) || isSegmentRecord(value);
}

export function isObservationsRecordedData(value: unknown): value is ObservationsRecordedEntryData {
	if (!isRecord(value)) return false;
	if (!hasOnlyKeys(value, ["version", "nodeRecords", "highWater", "coversUpToId", "segmentCheck", "warnings"])) return false;
	if (value.version !== 2 || !isNodeHighWater(value.highWater) || !Array.isArray(value.nodeRecords) || !value.nodeRecords.every(isNodeRecord)) return false;
	if (!["not_requested", "complete", "partial"].includes(String(value.segmentCheck))) return false;
	if (value.coversUpToId !== undefined && !isNonEmptySingleLine(value.coversUpToId)) return false;
	if (value.warnings !== undefined && (!Array.isArray(value.warnings) || !value.warnings.every(isNonEmptySingleLine))) return false;
	const hasObservation = value.nodeRecords.some(isObservationRecord);
	if (!hasObservation && value.segmentCheck === "not_requested") return false;
	return hasObservation ? isNonEmptySingleLine(value.coversUpToId) : value.coversUpToId === undefined;
}
