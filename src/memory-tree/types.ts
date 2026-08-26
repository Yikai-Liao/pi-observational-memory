export const OM_OBSERVATIONS_RECORDED = "om.observations.recorded";
export const SEGMENT_RENDERED_DETAILS = "om.segment-tree.rendered";

export const OBSERVATION_ID_PATTERN = /^[a-f0-9]{12}$/;
export const SEGMENT_ID_PATTERN = /^s_[a-f0-9]{12}$/;

export type SegmentId = `s_${string}`;
export type NodeId = string;

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
	version: 1;
	nodeRecords: Node[];
	coversUpToId?: string;
	segmentCheck: SegmentCheck;
	warnings?: string[];
};

export type SegmentMemoryDetails = {
	type: typeof SEGMENT_RENDERED_DETAILS;
	version: 1;
	memoryDepth: number;
	renderedNodeIds: NodeId[];
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
	return typeof value === "string" && (OBSERVATION_ID_PATTERN.test(value) || SEGMENT_ID_PATTERN.test(value));
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

export function isObservationRecord(value: unknown): value is Observation {
	if (!isRecord(value)) return false;
	return hasOnlyKeys(value, ["id", "content", "sourceEntryIds"])
		&& OBSERVATION_ID_PATTERN.test(String(value.id ?? ""))
		&& isNonEmptySingleLine(value.content)
		&& Array.isArray(value.sourceEntryIds)
		&& value.sourceEntryIds.length > 0
		&& value.sourceEntryIds.every(isNonEmptySingleLine)
		&& new Set(value.sourceEntryIds).size === value.sourceEntryIds.length;
}

export function isSegmentRecord(value: unknown): value is Segment {
	if (!isRecord(value)) return false;
	return hasOnlyKeys(value, ["id", "title", "summary", "childIds"])
		&& SEGMENT_ID_PATTERN.test(String(value.id ?? ""))
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
	if (!hasOnlyKeys(value, ["version", "nodeRecords", "coversUpToId", "segmentCheck", "warnings"])) return false;
	if (value.version !== 1 || !Array.isArray(value.nodeRecords) || !value.nodeRecords.every(isNodeRecord)) return false;
	if (!["not_requested", "complete", "partial"].includes(String(value.segmentCheck))) return false;
	if (value.coversUpToId !== undefined && !isNonEmptySingleLine(value.coversUpToId)) return false;
	if (value.warnings !== undefined && (!Array.isArray(value.warnings) || !value.warnings.every(isNonEmptySingleLine))) return false;
	const hasObservation = value.nodeRecords.some(isObservationRecord);
	if (!hasObservation && value.segmentCheck === "not_requested") return false;
	return hasObservation ? isNonEmptySingleLine(value.coversUpToId) : value.coversUpToId === undefined;
}
