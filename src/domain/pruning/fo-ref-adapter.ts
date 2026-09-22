import { createInputFingerprint } from "../../state.js";
import type { DcpMessage } from "../../types/message.js";
import type { PrunedToolAction, ToolRecord } from "../../types/state.js";
import { estimateTokens } from "../tokens/estimate.js";

export interface FoRefCandidateV1 {
  localId: string;
  compositeId: string;
  outerToolCallId: string;
  timelineId?: string;
  toolName: string;
  input: unknown;
  content: [{ type: "text"; text: string }];
  isError: boolean;
  error?: string;
  text: string;
  exposureCount: number;
  exposureIds: string[];
}

interface FoRefBridgeProjectRequestV1 {
  outerToolCallId: string;
  details: unknown;
  originalModelText: string;
  decisions: Readonly<Record<string, string>>;
  maxVisibleBytes: number;
  maxVisibleEventBytes?: number;
}

interface FoRefBridgeProjectedV1 {
  status: "projected";
  modelText: string;
  fullModelText: string;
  truncated: boolean;
  originalModelText: string;
  originalFullModelText: string;
  originalTruncated: boolean;
  savedModelTextCharacters: number;
  savedFullModelTextCharacters: number;
  appliedLocalIds: string[];
  ignoredLocalIds: string[];
}

interface FoRefBridgeUnchangedV1 {
  status: "unchanged";
  modelText: string;
  appliedLocalIds: [];
  ignoredLocalIds: string[];
}

export interface FoRefBridgeV1 {
  readonly version: 1;
  readonly registryKey: "fo.exposed-ref-bridge.v1";
  collect(request: {
    outerToolCallId: string;
    details: unknown;
  }):
    | { status: "supported"; version: 1; envelopeVersion: 1; candidates: FoRefCandidateV1[] }
    | { status: "unsupported" };
  project(request: FoRefBridgeProjectRequestV1): FoRefBridgeProjectedV1 | FoRefBridgeUnchangedV1;
  recover(request: { outerToolCallId: string; details: unknown; localId: string }): unknown;
}

export interface FoRefGroupedSourceRef {
  outerToolCallId: string;
  localId: string;
  compositeId: string;
  timelineId?: string;
  exposureIds: string[];
}

export type FoRefAdapterCollection =
  | {
      status: "supported";
      candidates: FoRefCandidateV1[];
      messages: DcpMessage[];
      records: ToolRecord[];
      groupedSourceRefs: FoRefGroupedSourceRef[];
      liveCompositeIds: string[];
    }
  | {
      status: "unsupported";
      messages: [];
      records: [];
      groupedSourceRefs: [];
      liveCompositeIds: [];
    };

export interface CollectFoRefAdapterCandidatesRequest {
  bridge: FoRefBridgeV1;
  outerToolCallId: string;
  details: unknown;
  outerRecord: Pick<ToolRecord, "turnIndex" | "timestamp">;
}

export function collectFoRefAdapterCandidates(
  request: CollectFoRefAdapterCandidatesRequest
): FoRefAdapterCollection {
  try {
    const collected = request.bridge.collect({
      outerToolCallId: request.outerToolCallId,
      details: request.details,
    });
    if (collected.status !== "supported") return unsupportedCollection();
    const seenCompositeIds = new Set<string>();
    const seenLocalIds = new Set<string>();
    const messages: DcpMessage[] = [];
    const records: ToolRecord[] = [];
    const groupedSourceRefs: FoRefGroupedSourceRef[] = [];

    for (const candidate of collected.candidates) {
      if (
        candidate.outerToolCallId !== request.outerToolCallId ||
        seenCompositeIds.has(candidate.compositeId) ||
        seenLocalIds.has(candidate.localId) ||
        candidate.content.length !== 1 ||
        candidate.content[0]?.type !== "text" ||
        candidate.content[0].text !== candidate.text
      ) {
        return unsupportedCollection();
      }
      seenCompositeIds.add(candidate.compositeId);
      seenLocalIds.add(candidate.localId);
      const inputArgs = normalizeInput(candidate.input);
      const content = structuredClone(candidate.content);
      messages.push({
        role: "toolResult",
        toolCallId: candidate.compositeId,
        toolName: candidate.toolName,
        content,
        isError: candidate.isError,
        timestamp: request.outerRecord.timestamp,
      });
      records.push({
        toolCallId: candidate.compositeId,
        toolName: candidate.toolName,
        inputArgs,
        inputFingerprint: createInputFingerprint(candidate.toolName, inputArgs),
        isError: candidate.isError,
        turnIndex: request.outerRecord.turnIndex,
        timestamp: request.outerRecord.timestamp,
        tokenEstimate: estimateTokens(candidate.text),
      });
      groupedSourceRefs.push({
        outerToolCallId: request.outerToolCallId,
        localId: candidate.localId,
        compositeId: candidate.compositeId,
        ...(candidate.timelineId ? { timelineId: candidate.timelineId } : {}),
        exposureIds: [...candidate.exposureIds],
      });
    }

    return {
      status: "supported",
      candidates: collected.candidates,
      messages,
      records,
      groupedSourceRefs,
      liveCompositeIds: [...seenCompositeIds],
    };
  } catch {
    return unsupportedCollection();
  }
}

function unsupportedCollection(): Extract<FoRefAdapterCollection, { status: "unsupported" }> {
  return {
    status: "unsupported",
    messages: [],
    records: [],
    groupedSourceRefs: [],
    liveCompositeIds: [],
  };
}

function normalizeInput(input: unknown): Record<string, unknown> {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    return structuredClone(input) as Record<string, unknown>;
  }
  return { input: structuredClone(input) };
}

export interface ProjectFoRefOuterResultRequest {
  bridge: FoRefBridgeV1;
  outerMessage: DcpMessage;
  outerToolCallId: string;
  details: unknown;
  persistedActions: ReadonlyMap<string, PrunedToolAction>;
  proposedActions?: ReadonlyMap<string, PrunedToolAction>;
  maxVisibleBytes: number;
  maxVisibleEventBytes?: number;
}

export type FoRefOuterProjection =
  | {
      status: "projected";
      message: DcpMessage;
      originalText: string;
      baselineText: string;
      projectedText: string;
      originalFullText: string;
      baselineFullText: string;
      projectedFullText: string;
      appliedCompositeIds: string[];
      ignoredCompositeIds: string[];
      liveCompositeIds: string[];
      groupedSourceRefs: FoRefGroupedSourceRef[];
    }
  | {
      status: "unchanged";
      message: DcpMessage;
      originalText: string;
      liveCompositeIds: string[];
      groupedSourceRefs: FoRefGroupedSourceRef[];
    };

export function projectFoRefOuterResult(
  request: ProjectFoRefOuterResultRequest
): FoRefOuterProjection {
  const textTarget = findSingleTextTarget(request.outerMessage);
  const collected = collectFoRefAdapterCandidates({
    bridge: request.bridge,
    outerToolCallId: request.outerToolCallId,
    details: request.details,
    outerRecord: { turnIndex: 0, timestamp: finiteTimestamp(request.outerMessage.timestamp) },
  });
  if (!textTarget || collected.status !== "supported") {
    return unchangedProjection(
      request.outerMessage,
      textTarget?.text ?? "",
      collected.liveCompositeIds,
      collected.groupedSourceRefs
    );
  }

  try {
    const byLocalId = new Map(
      collected.candidates.map((candidate) => [candidate.localId, candidate])
    );
    const baselineDecisions = buildLocalDecisions(collected.candidates, request.persistedActions);
    const combinedActions = new Map(request.persistedActions);
    for (const [id, action] of request.proposedActions ?? []) combinedActions.set(id, action);
    const projectedDecisions = buildLocalDecisions(collected.candidates, combinedActions);

    const projectionRequest = {
      outerToolCallId: request.outerToolCallId,
      details: request.details,
      originalModelText: textTarget.text,
      maxVisibleBytes: request.maxVisibleBytes,
      ...(request.maxVisibleEventBytes !== undefined
        ? { maxVisibleEventBytes: request.maxVisibleEventBytes }
        : {}),
    };
    const original = request.bridge.project({ ...projectionRequest, decisions: {} });
    if (original.status !== "projected" || original.modelText !== textTarget.text) {
      return unchangedProjection(
        request.outerMessage,
        textTarget.text,
        collected.liveCompositeIds,
        collected.groupedSourceRefs
      );
    }
    const baseline =
      Object.keys(baselineDecisions).length === 0
        ? original
        : request.bridge.project({ ...projectionRequest, decisions: baselineDecisions });
    const projected = request.bridge.project({
      ...projectionRequest,
      decisions: projectedDecisions,
    });
    if (baseline.status !== "projected" || projected.status !== "projected") {
      return unchangedProjection(
        request.outerMessage,
        textTarget.text,
        collected.liveCompositeIds,
        collected.groupedSourceRefs
      );
    }

    const requestedLocalIds = Object.keys(projectedDecisions);
    const appliedLocalIds = new Set(projected.appliedLocalIds);
    if (
      projected.appliedLocalIds.some(
        (id) => !Object.hasOwn(projectedDecisions, id) || !byLocalId.has(id)
      )
    ) {
      return unchangedProjection(
        request.outerMessage,
        textTarget.text,
        collected.liveCompositeIds,
        collected.groupedSourceRefs
      );
    }
    const appliedCompositeIds = requestedLocalIds
      .filter((id) => appliedLocalIds.has(id))
      .map((id) => byLocalId.get(id)!.compositeId);
    const ignoredCompositeIds = requestedLocalIds
      .filter((id) => !appliedLocalIds.has(id))
      .map((id) => byLocalId.get(id)!.compositeId);
    return {
      status: "projected",
      message: replaceTextTarget(request.outerMessage, textTarget, projected.modelText),
      originalText: textTarget.text,
      baselineText: baseline.modelText,
      projectedText: projected.modelText,
      originalFullText: baseline.originalFullModelText,
      baselineFullText: baseline.fullModelText,
      projectedFullText: projected.fullModelText,
      appliedCompositeIds,
      ignoredCompositeIds,
      liveCompositeIds: collected.liveCompositeIds,
      groupedSourceRefs: collected.groupedSourceRefs,
    };
  } catch {
    return unchangedProjection(
      request.outerMessage,
      textTarget.text,
      collected.liveCompositeIds,
      collected.groupedSourceRefs
    );
  }
}

function buildLocalDecisions(
  candidates: FoRefCandidateV1[],
  actions: ReadonlyMap<string, PrunedToolAction>
): Record<string, string> {
  const decisions: Record<string, string> = {};
  for (const candidate of candidates) {
    const action = actions.get(candidate.compositeId);
    if (!action) continue;
    decisions[candidate.localId] = renderAction(candidate, action);
  }
  return decisions;
}

function renderAction(candidate: FoRefCandidateV1, action: PrunedToolAction): string {
  if (action.action === "clear") {
    const recovery = `dcp_recover({id:${JSON.stringify(candidate.compositeId)}})`;
    return candidate.isError
      ? `[Error output removed by DCP; original retained: ${recovery}]`
      : `[Output removed by DCP; original retained: ${recovery}]`;
  }
  const lines = candidate.text.split("\n");
  const headLines = normalizeLineCount(action.headLines);
  const tailLines = normalizeLineCount(action.tailLines);
  const removedCount = Math.max(0, lines.length - headLines - tailLines);
  if (removedCount === 0) return candidate.text;
  return [
    ...lines.slice(0, headLines),
    `[... ${removedCount} lines removed by DCP; original retained: dcp_recover({id:${JSON.stringify(candidate.compositeId)}}) ...]`,
    ...(tailLines > 0 ? lines.slice(lines.length - tailLines) : []),
  ].join("\n");
}

function normalizeLineCount(value: number): number {
  return Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
}

interface TextTarget {
  text: string;
  contentIndex?: number;
}

function findSingleTextTarget(message: DcpMessage): TextTarget | null {
  if (typeof message.content === "string") return { text: message.content };
  if (!Array.isArray(message.content) || message.content.length !== 1) return null;
  const part = message.content[0];
  if (
    part === null ||
    typeof part !== "object" ||
    (part as { type?: unknown }).type !== "text" ||
    typeof (part as { text?: unknown }).text !== "string"
  )
    return null;
  return { text: (part as { text: string }).text, contentIndex: 0 };
}

function replaceTextTarget(message: DcpMessage, target: TextTarget, text: string): DcpMessage {
  if (target.contentIndex === undefined) return { ...message, content: text };
  const content = [...message.content];
  content[target.contentIndex] = { ...content[target.contentIndex], text };
  return { ...message, content };
}

function unchangedProjection(
  message: DcpMessage,
  originalText: string,
  liveCompositeIds: string[],
  groupedSourceRefs: FoRefGroupedSourceRef[]
): Extract<FoRefOuterProjection, { status: "unchanged" }> {
  return { status: "unchanged", message, originalText, liveCompositeIds, groupedSourceRefs };
}

function finiteTimestamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
