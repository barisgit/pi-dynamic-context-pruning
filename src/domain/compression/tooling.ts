// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) — pure compression helpers
// ---------------------------------------------------------------------------

import { createEmptyCompressionBlockMetadata } from "./metadata.js";
import type {
  CompressionBlock,
  CompressionBlockMetadata,
  CompressionLogEntry,
  DcpState,
} from "../../types/state.js";
import { stripDcpMetadataTags } from "../refs/metadata.js";
import { parseVisibleRef } from "../refs/index.js";
import { estimateMessageTokens, estimateTokens, resolveCompressionRangeIndices } from "./range.js";
import {
  buildTranscriptSnapshot,
  resolveCompressionBlockCoveredSourceKeys,
  resolveLogicalTurnTailStartTimestamp,
} from "../transcript/index.js";

const MAX_EXCERPT_CHARS = 420;

type CompressionArtifacts = {
  activityLogVersion: 1;
  activityLog: CompressionLogEntry[];
  metadata: CompressionBlockMetadata;
};

type ToolCallDescriptor = {
  toolName: string;
  inputArgs: Record<string, unknown>;
};

/** Suggested visible raw range that is currently safe to compress. */
export interface CompressionCandidateRange {
  startId: string;
  endId: string;
  tokenEstimate: number;
}

/** Diagnostic hints for choosing safe compression boundaries. */
export interface CompressionPlanningHints {
  protectedTailStartId: string | null;
  protectedMessageIds: string[];
  protectedBlockIds: string[];
  candidateRanges: CompressionCandidateRange[];
}

const DEFAULT_CANDIDATE_LIMIT = 3;
const MAX_RENDERED_PROTECTED_MESSAGE_IDS = 8;
const MAX_RENDERED_PROTECTED_BLOCK_IDS = 6;

/**
 * Replace `(bN)` placeholders in a summary with the stored content of the
 * referenced compression block. Unrecognised placeholders are left as-is.
 */
export function expandBlockPlaceholders(summary: string, state: DcpState): string {
  return summary.replace(/\(b(\d+)\)/g, (match, idStr) => {
    const id = parseInt(idStr, 10);
    const block = state.compressionBlocks.find((b) => b.id === id && b.active);
    return block ? `[Previously compressed: ${block.topic}]\n${block.summary}` : match;
  });
}

/**
 * Resolve a user-supplied ID string (e.g. "m0001", transitional "m001", or "b3")
 * to an actual message timestamp.
 */
export function resolveIdToTimestamp(
  rawId: string,
  field: "startTimestamp" | "endTimestamp",
  state: DcpState
): number {
  const id = rawId.trim();
  const parsed = parseVisibleRef(id);

  if (parsed?.kind === "block") {
    const block = state.compressionBlocks.find((b) => b.id === parsed.blockId && b.active);
    if (!block) throw new Error(`Unknown message ID: ${id}`);
    return block[field];
  }

  if (parsed?.kind !== "message") {
    throw new Error(
      `Invalid message ID: ${id}. Expected a stable message ref like m0001 or a block ref like b3.`
    );
  }

  const ts = state.messageIdSnapshot.get(parsed.ref) ?? state.messageIdSnapshot.get(id);
  if (ts === undefined) throw new Error(`Unknown message ID: ${id}`);
  return ts;
}

export function resolveIdToSourceKey(
  rawId: string,
  state: DcpState,
  blockField: "startSourceKey" | "endSourceKey"
): string | null {
  const id = rawId.trim();
  const parsed = parseVisibleRef(id);

  if (parsed?.kind === "block") {
    const block = state.compressionBlocks.find((b) => b.id === parsed.blockId && b.active);
    return block?.[blockField] ?? null;
  }

  if (parsed?.kind !== "message") return null;
  return (
    state.messageRefSnapshot.get(parsed.ref)?.sourceKey ??
    state.messageRefSnapshot.get(id)?.sourceKey ??
    null
  );
}

/**
 * Determine the anchor timestamp for a compression block — the timestamp of
 * the first raw message that appears strictly after `endTimestamp`.
 */
export function resolveAnchorTimestamp(endTimestamp: number, state: DcpState): number {
  let anchor: number | null = null;
  for (const ts of state.messageIdSnapshot.values()) {
    if (ts > endTimestamp && (anchor === null || ts < anchor)) {
      anchor = ts;
    }
  }
  return anchor ?? Infinity;
}

export function resolveAnchorSourceKey(
  endTimestamp: number,
  endSourceKey: string | null,
  state: DcpState
): string | undefined {
  let anchor: { timestamp: number; sourceKey: string } | null = null;
  for (const entry of state.messageRefSnapshot.values()) {
    if (entry.timestamp === null) continue;
    if (entry.timestamp > endTimestamp && (anchor === null || entry.timestamp < anchor.timestamp)) {
      anchor = { timestamp: entry.timestamp, sourceKey: entry.sourceKey };
    }
  }
  return anchor?.sourceKey ?? (endSourceKey ? `tail:${endSourceKey}` : undefined);
}

export function validateCompressionRangeBoundaryIds(
  startId: string,
  endId: string,
  state: DcpState
): void {
  const parsedStartId = parseVisibleRef(startId);
  const parsedEndId = parseVisibleRef(endId);

  if (!parsedStartId) {
    throw new Error(
      `Invalid message ID: ${startId}. Expected a stable message ref like m0001 or m10000, or a block ref like b3.`
    );
  }
  if (!parsedEndId) {
    throw new Error(
      `Invalid message ID: ${endId}. Expected a stable message ref like m0001 or m10000, or a block ref like b3.`
    );
  }

  if (
    parsedStartId.kind === "message" &&
    !state.messageIdSnapshot.has(parsedStartId.ref) &&
    !state.messageIdSnapshot.has(startId.trim())
  ) {
    throw new Error(`Unknown message ID: ${startId}`);
  }
  if (
    parsedEndId.kind === "message" &&
    !state.messageIdSnapshot.has(parsedEndId.ref) &&
    !state.messageIdSnapshot.has(endId.trim())
  ) {
    throw new Error(`Unknown message ID: ${endId}`);
  }

  if (
    parsedStartId.kind === "block" &&
    !state.compressionBlocks.some((block) => block.id === parsedStartId.blockId && block.active)
  ) {
    throw new Error(`Unknown message ID: ${startId}`);
  }
  if (
    parsedEndId.kind === "block" &&
    !state.compressionBlocks.some((block) => block.id === parsedEndId.blockId && block.active)
  ) {
    throw new Error(`Unknown message ID: ${endId}`);
  }

  if (
    parsedStartId.kind === "block" &&
    parsedEndId.kind === "block" &&
    parsedStartId.blockId === parsedEndId.blockId
  ) {
    throw new Error(
      `Range ${startId}..${endId} contains only compressed block b${parsedStartId.blockId}. ` +
        `Choose raw message boundaries around the block or include additional uncompressed messages.`
    );
  }
}

function resolveVisibleIdForTimestamp(timestamp: number, state: DcpState): string | null {
  for (const [messageId, candidateTimestamp] of state.messageIdSnapshot.entries()) {
    if (candidateTimestamp === timestamp) return messageId;
  }
  return null;
}

function compareMessageIds(a: string, b: string): number {
  return parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10);
}

function compareBlockIds(a: string, b: string): number {
  return parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10);
}

/** Deduplicate message IDs that refer to the same numeric index (e.g. m0087 vs m087). */
function deduplicateMessageIds(ids: string[]): string[] {
  const seen = new Set<number>();
  return ids.filter((id) => {
    const numeric = parseInt(id.slice(1), 10);
    if (seen.has(numeric)) return false;
    seen.add(numeric);
    return true;
  });
}

function summarizeIdList(ids: string[], limit: number): string {
  const visibleIds = ids.slice(0, limit);
  const hiddenCount = ids.length - visibleIds.length;
  if (hiddenCount > 0) {
    return `${visibleIds.join(", ")} (+${hiddenCount} more)`;
  }
  return visibleIds.join(", ");
}

function formatCandidateRange(candidate: CompressionCandidateRange): string {
  if (candidate.startId === candidate.endId) return candidate.startId;
  return `${candidate.startId}..${candidate.endId}`;
}

function estimateMessageTokenCost(message: any): number {
  return estimateMessageTokens(message);
}

function collectCoveredSourceKeys(
  snapshot: ReturnType<typeof buildTranscriptSnapshot>,
  compressionBlocks: CompressionBlock[]
): Set<string> {
  const coveredSourceKeys = new Set<string>();

  for (const block of compressionBlocks) {
    if (!block.active) continue;

    const exactCoveredSourceKeys = resolveCompressionBlockCoveredSourceKeys(snapshot, block);
    if (exactCoveredSourceKeys !== null) {
      for (const sourceKey of exactCoveredSourceKeys) {
        coveredSourceKeys.add(sourceKey);
      }
      continue;
    }

    if (!Number.isFinite(block.startTimestamp) || !Number.isFinite(block.endTimestamp)) continue;

    for (const item of snapshot.sourceItems) {
      if (item.timestamp === null) continue;
      if (item.timestamp < block.startTimestamp || item.timestamp > block.endTimestamp) continue;
      coveredSourceKeys.add(item.key);
    }
  }

  return coveredSourceKeys;
}

/**
 * Build structured diagnostics about the current hot tail and safe candidate
 * ranges the agent can use for compression.
 */
export function buildCompressionPlanningHints(
  messages: any[],
  state: DcpState,
  protectRecentTurns: number,
  candidateLimit: number = DEFAULT_CANDIDATE_LIMIT
): CompressionPlanningHints {
  const protectedTailStartTimestamp = resolveProtectedTailStartTimestamp(
    messages,
    protectRecentTurns
  );
  const protectedTailStartId =
    protectedTailStartTimestamp === null
      ? null
      : resolveVisibleIdForTimestamp(protectedTailStartTimestamp, state);

  const protectedMessageIds =
    protectedTailStartTimestamp === null
      ? []
      : deduplicateMessageIds(
          Array.from(state.messageIdSnapshot.entries())
            .filter(([, timestamp]) => timestamp >= protectedTailStartTimestamp)
            .map(([messageId]) => messageId)
            .sort(compareMessageIds)
        );

  const protectedBlockIds =
    protectedTailStartTimestamp === null
      ? []
      : state.compressionBlocks
          .filter(
            (block) =>
              block.active &&
              Number.isFinite(block.endTimestamp) &&
              block.endTimestamp >= protectedTailStartTimestamp
          )
          .map((block) => `b${block.id}`)
          .sort(compareBlockIds);

  const snapshot = buildTranscriptSnapshot(messages);
  const sourceItemByKey = new Map(snapshot.sourceItems.map((item) => [item.key, item]));
  const coveredSourceKeys = collectCoveredSourceKeys(snapshot, state.compressionBlocks);
  const candidateRanges: CompressionCandidateRange[] = [];
  let activeCandidate: CompressionCandidateRange | null = null;

  const pushActiveCandidate = (): void => {
    if (!activeCandidate || activeCandidate.tokenEstimate <= 0) {
      activeCandidate = null;
      return;
    }
    candidateRanges.push(activeCandidate);
    activeCandidate = null;
  };

  for (const span of snapshot.spans) {
    const sourceItems = span.sourceKeys
      .map((sourceKey) => sourceItemByKey.get(sourceKey))
      .filter((item): item is NonNullable<typeof item> => item !== undefined);

    if (sourceItems.length === 0) {
      pushActiveCandidate();
      continue;
    }

    const timestamps = sourceItems
      .map((item) => item.timestamp)
      .filter((timestamp): timestamp is number => timestamp !== null && Number.isFinite(timestamp));

    if (timestamps.length === 0) {
      pushActiveCandidate();
      continue;
    }

    const spanStartTimestamp = timestamps[0]!;
    const spanEndTimestamp = timestamps[timestamps.length - 1]!;
    const spanStartId = resolveVisibleIdForTimestamp(spanStartTimestamp, state);
    const spanEndId = resolveVisibleIdForTimestamp(spanEndTimestamp, state);
    const touchesProtectedTail =
      protectedTailStartTimestamp !== null && spanEndTimestamp >= protectedTailStartTimestamp;
    const isCovered = sourceItems.some((item) => coveredSourceKeys.has(item.key));

    if (!spanStartId || !spanEndId || touchesProtectedTail || isCovered) {
      pushActiveCandidate();
      continue;
    }

    const spanTokenEstimate = sourceItems.reduce(
      (sum, item) => sum + estimateMessageTokenCost(item.message),
      0
    );

    if (spanTokenEstimate <= 0) {
      pushActiveCandidate();
      continue;
    }

    if (!activeCandidate) {
      activeCandidate = {
        startId: spanStartId,
        endId: spanEndId,
        tokenEstimate: 0,
      };
    }

    activeCandidate.endId = spanEndId;
    activeCandidate.tokenEstimate += spanTokenEstimate;
  }

  pushActiveCandidate();

  candidateRanges.sort((a, b) => {
    if (b.tokenEstimate !== a.tokenEstimate) return b.tokenEstimate - a.tokenEstimate;
    return compareMessageIds(a.startId, b.startId);
  });

  return {
    protectedTailStartId,
    protectedMessageIds,
    protectedBlockIds,
    candidateRanges: candidateRanges.slice(0, Math.max(0, candidateLimit)),
  };
}

/** Render concise hot-tail and candidate-range guidance for the agent. */
export function renderCompressionPlanningHints(
  hints: CompressionPlanningHints,
  options: { includeTailStart?: boolean } = {}
): string {
  const { includeTailStart = true } = options;
  const lines: string[] = [];

  if (includeTailStart && hints.protectedTailStartId) {
    lines.push(`Protected hot tail starts at ${hints.protectedTailStartId}.`);
  }

  const protectedParts: string[] = [];
  if (hints.protectedMessageIds.length > 0) {
    protectedParts.push(
      `messages ${summarizeIdList(hints.protectedMessageIds, MAX_RENDERED_PROTECTED_MESSAGE_IDS)}`
    );
  }
  if (hints.protectedBlockIds.length > 0) {
    protectedParts.push(
      `blocks ${summarizeIdList(hints.protectedBlockIds, MAX_RENDERED_PROTECTED_BLOCK_IDS)}`
    );
  }
  if (protectedParts.length > 0) {
    lines.push(`Do not use these as endId right now: ${protectedParts.join("; ")}.`);
  }

  if (hints.candidateRanges.length > 0) {
    lines.push("Largest safe uncompressed ranges right now:");
    for (const candidate of hints.candidateRanges) {
      lines.push(`- ${formatCandidateRange(candidate)} (~${candidate.tokenEstimate} tokens)`);
    }
  }

  return lines.join("\n");
}

function normalizeInlineWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…";
}

function countLines(text: string): number {
  return text === "" ? 0 : text.split(/\r?\n/).length;
}

function getTextParts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];

  return content
    .flatMap((part: any) => {
      if (!part || typeof part !== "object") return [];
      if (typeof part.text === "string") return [part.text];
      if (typeof part.input === "string") return [part.input];
      return [];
    })
    .filter((text): text is string => text.length > 0);
}

function extractMessageExcerpt(message: any): string | null {
  const joined = normalizeInlineWhitespace(
    stripDcpMetadataTags(getTextParts(message?.content).join(" "))
  );
  if (!joined) return null;
  return truncateText(joined, MAX_EXCERPT_CHARS);
}

function quotedExcerpt(text: string): string {
  return `"${text}"`;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatReadLineSpan(args: Record<string, unknown>): string | null {
  const offset = asFiniteNumber(args.offset);
  const limit = asFiniteNumber(args.limit);
  if (offset === null) return null;
  if (limit === null || limit <= 1) return `L${offset}`;
  return `L${offset}-L${offset + Math.max(0, limit - 1)}`;
}

function upsertFileReadStat(
  metadata: CompressionBlockMetadata,
  path: string,
  lineSpan: string | null
): void {
  let stat = metadata.fileReadStats.find((candidate) => candidate.path === path);
  if (!stat) {
    stat = { path, count: 0, lineSpans: [] };
    metadata.fileReadStats.push(stat);
  }
  stat.count++;
  if (lineSpan && !stat.lineSpans.includes(lineSpan)) {
    stat.lineSpans.push(lineSpan);
  }
}

function upsertFileWriteStat(
  metadata: CompressionBlockMetadata,
  path: string,
  editCount: number,
  addedLines: number,
  removedLines: number
): void {
  let stat = metadata.fileWriteStats.find((candidate) => candidate.path === path);
  if (!stat) {
    stat = { path, editCount: 0, addedLines: 0, removedLines: 0 };
    metadata.fileWriteStats.push(stat);
  }
  stat.editCount += editCount;
  stat.addedLines += addedLines;
  stat.removedLines += removedLines;
}

function pushCommandStat(
  metadata: CompressionBlockMetadata,
  command: string,
  status: "ok" | "error" | "other"
): void {
  metadata.commandStats.push({ command, status });
}

function classifyCommandKind(command: string): "command" | "test" | "commit" {
  if (/^git\s+commit\b/.test(command)) return "commit";
  if (
    /(^|\s)(bun\s+run|npm\s+test|pnpm\s+test|yarn\s+test|vitest|jest|pytest|cargo\s+test|go\s+test)\b/.test(
      command
    )
  ) {
    return "test";
  }
  return "command";
}

function buildEditStats(edits: unknown): {
  editCount: number;
  addedLines: number;
  removedLines: number;
} {
  if (!Array.isArray(edits)) {
    return { editCount: 0, addedLines: 0, removedLines: 0 };
  }

  let addedLines = 0;
  let removedLines = 0;
  let editCount = 0;

  for (const rawEdit of edits) {
    const edit = asObject(rawEdit);
    if (!edit) continue;
    editCount++;

    const oldText = typeof edit.oldText === "string" ? edit.oldText : "";
    const newText = typeof edit.newText === "string" ? edit.newText : "";
    const oldLines = countLines(oldText);
    const newLines = countLines(newText);

    if (newLines > oldLines) {
      addedLines += newLines - oldLines;
    } else if (oldLines > newLines) {
      removedLines += oldLines - newLines;
    }
  }

  return { editCount, addedLines, removedLines };
}

function summarizeGenericToolArgs(args: Record<string, unknown>): string {
  const path = typeof args.path === "string" ? args.path : null;
  const pattern = typeof args.pattern === "string" ? args.pattern : null;
  const command = typeof args.command === "string" ? args.command : null;

  if (path && pattern) return `${path} ${pattern}`;
  if (path) return path;
  if (command) return truncateText(normalizeInlineWhitespace(command), MAX_EXCERPT_CHARS);
  if (pattern) return pattern;
  return "";
}

function parseToolCallArguments(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }

  return {};
}

function buildToolCallLookup(messages: any[]): Map<string, ToolCallDescriptor> {
  const lookup = new Map<string, ToolCallDescriptor>();

  for (const message of messages) {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;

    for (const block of message.content) {
      if (!block || typeof block !== "object") continue;
      if (
        block.type !== "toolCall" ||
        typeof block.id !== "string" ||
        typeof block.name !== "string"
      ) {
        continue;
      }

      lookup.set(block.id, {
        toolName: block.name,
        inputArgs: parseToolCallArguments((block as any).arguments),
      });
    }
  }

  return lookup;
}

function buildToolLogEntry(
  message: any,
  state: DcpState,
  toolCallLookup: Map<string, ToolCallDescriptor>,
  metadata: CompressionBlockMetadata
): CompressionLogEntry | null {
  const toolCallId = typeof message?.toolCallId === "string" ? message.toolCallId : null;
  if (toolCallId) {
    metadata.coveredToolIds.push(toolCallId);
    metadata.coveredArtifactRefs.push(`tool:${toolCallId}`);
  }

  const record = toolCallId ? state.toolCalls.get(toolCallId) : undefined;
  const descriptor = toolCallId ? toolCallLookup.get(toolCallId) : undefined;
  const toolName =
    typeof message?.toolName === "string"
      ? message.toolName
      : (descriptor?.toolName ?? record?.toolName);
  const args = descriptor?.inputArgs ?? record?.inputArgs ?? {};

  if (!toolName) return null;

  if (toolName === "read") {
    const path = typeof args.path === "string" ? args.path : "(unknown path)";
    const lineSpan = formatReadLineSpan(args);
    upsertFileReadStat(metadata, path, lineSpan);
    return {
      kind: "read",
      text: lineSpan ? `${path}#${lineSpan}` : path,
    };
  }

  if (toolName === "edit") {
    const path = typeof args.path === "string" ? args.path : "(unknown path)";
    const stats = buildEditStats(args.edits);
    upsertFileWriteStat(metadata, path, stats.editCount, stats.addedLines, stats.removedLines);
    return {
      kind: "edit",
      text: `${path} (${stats.editCount} edit${stats.editCount === 1 ? "" : "s"}, +${stats.addedLines}/-${stats.removedLines})`,
    };
  }

  if (toolName === "write") {
    const path = typeof args.path === "string" ? args.path : "(unknown path)";
    const content = typeof args.content === "string" ? args.content : "";
    const addedLines = countLines(content);
    upsertFileWriteStat(metadata, path, 1, addedLines, 0);
    return {
      kind: "write",
      text: `${path} (${addedLines} lines)`,
    };
  }

  if (toolName === "bash") {
    const rawCommand = typeof args.command === "string" ? args.command : "(unknown command)";
    const command = truncateText(normalizeInlineWhitespace(rawCommand), MAX_EXCERPT_CHARS);
    const status = message?.isError ? "error" : "ok";
    pushCommandStat(metadata, rawCommand, status);
    return {
      kind: classifyCommandKind(rawCommand),
      text: `${command} -> ${status}`,
    };
  }

  const suffix = summarizeGenericToolArgs(args);
  return {
    kind: "tool",
    text: suffix ? `${toolName} ${suffix}` : toolName,
  };
}

export function resolveProtectedTailStartTimestamp(
  messages: any[],
  protectRecentTurns: number
): number | null {
  return resolveLogicalTurnTailStartTimestamp(messages, protectRecentTurns);
}

function buildOverlapError(startId: string, endId: string, existing: CompressionBlock): Error {
  return new Error(
    `Overlapping compression ranges are not supported. ` +
      `New range (${startId}..${endId}) overlaps existing block ` +
      `b${existing.id} "${existing.topic}". ` +
      `Choose a range entirely before or after b${existing.id}, or compress relative to b${existing.id} itself.`
  );
}

export function resolveSupersededBlockIdsForRange(
  messages: any[],
  compressionBlocks: CompressionBlock[],
  startTimestamp: number,
  endTimestamp: number,
  newCoveredSourceKeys: Iterable<string>,
  startId: string,
  endId: string,
  ignoredBlockIds: Set<number> = new Set()
): number[] {
  const snapshot = buildTranscriptSnapshot(messages);
  const newCoveredSourceKeySet = new Set(newCoveredSourceKeys);
  const supersededBlockIds: number[] = [];

  for (const existing of compressionBlocks) {
    if (!existing.active) continue;
    if (ignoredBlockIds.has(existing.id)) continue;
    if (!Number.isFinite(existing.startTimestamp) || !Number.isFinite(existing.endTimestamp))
      continue;

    const overlaps =
      startTimestamp <= existing.endTimestamp && existing.startTimestamp <= endTimestamp;
    if (!overlaps) continue;

    const existingCoveredSourceKeys = resolveCompressionBlockCoveredSourceKeys(snapshot, existing);
    if (existingCoveredSourceKeys === null || existingCoveredSourceKeys.size === 0) {
      throw buildOverlapError(startId, endId, existing);
    }

    let coveredCount = 0;
    for (const sourceKey of existingCoveredSourceKeys) {
      if (newCoveredSourceKeySet.has(sourceKey)) coveredCount++;
    }

    if (coveredCount === existingCoveredSourceKeys.size) {
      supersededBlockIds.push(existing.id);
      continue;
    }

    throw buildOverlapError(startId, endId, existing);
  }

  return supersededBlockIds;
}

function buildCompressionArtifactsFromMessages(
  messages: any[],
  state: DcpState,
  metadata: CompressionBlockMetadata = createEmptyCompressionBlockMetadata()
): CompressionArtifacts {
  const activityLog: CompressionLogEntry[] = [];
  const toolCallLookup = buildToolCallLookup(messages);

  for (const message of messages) {
    const timestamp =
      typeof message?.timestamp === "number" && Number.isFinite(message.timestamp)
        ? message.timestamp
        : null;
    if (timestamp !== null) {
      metadata.coveredArtifactRefs.push(`message:${timestamp}`);
    }

    if (message?.role === "user") {
      const excerpt = extractMessageExcerpt(message);
      if (excerpt) activityLog.push({ kind: "user_excerpt", text: quotedExcerpt(excerpt) });
      continue;
    }

    if (message?.role === "assistant") {
      const excerpt = extractMessageExcerpt(message);
      if (excerpt) activityLog.push({ kind: "assistant_excerpt", text: quotedExcerpt(excerpt) });
      continue;
    }

    if (message?.role === "toolResult" || message?.role === "bashExecution") {
      const entry = buildToolLogEntry(message, state, toolCallLookup, metadata);
      if (entry) activityLog.push(entry);
    }
  }

  metadata.coveredToolIds = Array.from(new Set(metadata.coveredToolIds));
  metadata.coveredArtifactRefs = Array.from(new Set(metadata.coveredArtifactRefs));

  return {
    activityLogVersion: 1,
    activityLog,
    metadata,
  };
}

export function buildCompressionArtifactsForRange(
  messages: any[],
  state: DcpState,
  startTimestamp: number,
  endTimestamp: number
): CompressionArtifacts {
  const range = resolveCompressionRangeIndices(messages, startTimestamp, endTimestamp);
  if (!range) {
    return {
      activityLogVersion: 1,
      activityLog: [],
      metadata: createEmptyCompressionBlockMetadata(),
    };
  }

  const snapshot = buildTranscriptSnapshot(messages);
  const coveredItems = snapshot.sourceItems.slice(range.lo, range.hi + 1);
  const coveredSourceKeys = coveredItems.map((item) => item.key);
  const coveredSourceKeySet = new Set(coveredSourceKeys);
  const metadata = createEmptyCompressionBlockMetadata();
  metadata.coveredSourceKeys = coveredSourceKeys;
  metadata.coveredSpanKeys = snapshot.spans
    .filter((span) => span.sourceKeys.every((key) => coveredSourceKeySet.has(key)))
    .map((span) => span.key);

  return buildCompressionArtifactsFromMessages(
    messages.slice(range.lo, range.hi + 1),
    state,
    metadata
  );
}
