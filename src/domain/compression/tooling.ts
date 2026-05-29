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
  /** Largest safe ranges, sorted by token estimate desc, truncated to candidateLimit. */
  candidateRanges: CompressionCandidateRange[];
  /** Total safe ranges discovered before top-N truncation. */
  totalCandidateCount: number;
  /** Sum of token estimates across every safe range, before top-N truncation. */
  totalCompressibleTokens: number;
}

const DEFAULT_CANDIDATE_LIMIT = 10;

// Passthrough roles never get a visible message ref of their own (see
// injectMessageIds skipping them), but the compression splice still removes
// them when their timestamps fall inside a covered range. In planning, treat
// them as transparent: do not flush the running safe candidate, just absorb
// their tokens and keep extending across them.
const PASSTHROUGH_ROLES = new Set(["compaction", "branch_summary", "custom_message"]);
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

function formatUnavailableBlockRefHint(
  unavailableRef: string,
  coveringBlock: CompressionBlock,
  state: DcpState
): string {
  const { startRef, endRef } = resolveExistingBlockBoundaryRefs(coveringBlock, state);
  const blockRef = `b${coveringBlock.id}`;
  const boundaryHint =
    startRef && endRef
      ? ` ${blockRef} covers original raw span ${startRef}..${endRef}; the usable boundary for that whole span is ${blockRef}.`
      : ` ${blockRef} covers a compressed span containing ${unavailableRef}; its original raw start/end IDs are not available in the current alias table, so the only valid span ref is ${blockRef}.`;

  return (
    ` Message ID ${unavailableRef} is inside ${blockRef}; do not use raw IDs inside a compressed block as boundaries.` +
    boundaryHint
  );
}

function buildUnavailableMessageRefError(rawId: string, ref: string, state: DcpState): Error {
  const sourceKey = state.messageAliases.byRef.get(ref);
  if (sourceKey) {
    const coveringBlock = state.compressionBlocks.find((block) => {
      if (!block.active) return false;
      const coveredSourceKeys = block.metadata?.coveredSourceKeys ?? [];
      return coveredSourceKeys.includes(sourceKey);
    });

    if (coveringBlock) {
      return new Error(
        `Message ID ${rawId} is not available as a compression boundary because it is inside existing compressed block b${coveringBlock.id} "${coveringBlock.topic}".` +
          `${formatUnavailableBlockRefHint(rawId, coveringBlock, state)} ` +
          `Use boundary ref b${coveringBlock.id} to include that whole block and include (b${coveringBlock.id}) exactly once in the summary, ` +
          `or choose currently visible mNNNN boundaries outside b${coveringBlock.id}. Do not retry a range that starts or ends inside b${coveringBlock.id}.`
      );
    }
  }

  return new Error(`Unknown message ID: ${rawId}`);
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
    throw buildUnavailableMessageRefError(startId, parsedStartId.ref, state);
  }
  if (
    parsedEndId.kind === "message" &&
    !state.messageIdSnapshot.has(parsedEndId.ref) &&
    !state.messageIdSnapshot.has(endId.trim())
  ) {
    throw buildUnavailableMessageRefError(endId, parsedEndId.ref, state);
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
  const protectedMessageIds =
    protectedTailStartTimestamp === null
      ? []
      : deduplicateMessageIds(
          Array.from(state.messageIdSnapshot.entries())
            .filter(([, timestamp]) => timestamp >= protectedTailStartTimestamp)
            .map(([messageId]) => messageId)
            .sort(compareMessageIds)
        );

  // The protected-tail boundary is the START of the Nth-from-last logical turn.
  // For a `tool-exchange` turn that start is the assistant tool-call message,
  // which never receives a visible ref (see injectMessageIds), so a direct
  // timestamp lookup returns null. Fall back to the first visible protected id
  // (the turn's toolResult/bashExecution, already collected above) so the nudge
  // can still name an addressable hot-tail boundary instead of silently
  // dropping the "Protected hot tail starts at ..." hint.
  const protectedTailStartId =
    protectedTailStartTimestamp === null
      ? null
      : (resolveVisibleIdForTimestamp(protectedTailStartTimestamp, state) ??
        protectedMessageIds[0] ??
        null);

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
  // Tokens from transparent spans (passthrough roles or zero-ref assistant
  // output) that currently fall AFTER the candidate's endId. They only become
  // real savings if a later resolvable span extends endId past them (making
  // them interior to the range). If the candidate flushes first they trail
  // beyond endId, the compression splice over startId..endId will not remove
  // them, and counting them would overstate the suggested range. So they are
  // committed on extension and dropped on flush.
  let pendingTransparentTokens = 0;

  const pushActiveCandidate = (): void => {
    pendingTransparentTokens = 0;
    if (!activeCandidate || activeCandidate.tokenEstimate <= 0) {
      activeCandidate = null;
      return;
    }
    candidateRanges.push(activeCandidate);
    activeCandidate = null;
  };

  const isPassthroughOnlySpan = (items: ReadonlyArray<{ role: string }>): boolean =>
    items.length > 0 && items.every((item) => PASSTHROUGH_ROLES.has(item.role));

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

    const spanEndTimestamp = timestamps[timestamps.length - 1]!;
    const touchesProtectedTail =
      protectedTailStartTimestamp !== null && spanEndTimestamp >= protectedTailStartTimestamp;
    const isCovered = sourceItems.some((item) => coveredSourceKeys.has(item.key));

    // Anything in the hot tail or already inside an active compression block
    // ends the running candidate regardless of role.
    if (touchesProtectedTail || isCovered) {
      pushActiveCandidate();
      continue;
    }

    const spanTokenEstimate = sourceItems.reduce(
      (sum, item) => sum + estimateMessageTokenCost(item.message),
      0
    );

    // Passthrough-only spans (reminders, branch summaries, native compactions)
    // have no visible message ref but ARE removed by the compression splice
    // when their timestamps fall inside the range. Keep the running candidate
    // alive and absorb their tokens so a long stretch of raw history is not
    // fragmented by every reminder injection.
    if (isPassthroughOnlySpan(sourceItems)) {
      if (activeCandidate && spanTokenEstimate > 0) {
        pendingTransparentTokens += spanTokenEstimate;
      }
      continue;
    }

    // Derive the span's addressable visible refs from its resolvable items,
    // not the raw first/last timestamp. A `tool-exchange` span starts with an
    // assistant tool-call message, which never receives a visible ref (see
    // injectMessageIds); its trailing toolResult/bashExecution does, and the
    // assistant is pulled back in by atomic-pair expansion when the agent
    // references that ref. Using timestamps[0] here resolved to null for every
    // tool batch and fragmented each one into its own tiny range.
    const resolvableIds = sourceItems
      .map((item) =>
        item.timestamp !== null ? resolveVisibleIdForTimestamp(item.timestamp, state) : null
      )
      .filter((id): id is string => id !== null);

    // Spans with no addressable visible ref (standalone assistant output,
    // unmatched tool calls) are transparent like passthrough roles: a
    // compression splice over the surrounding range removes them anyway, so
    // absorb their tokens and keep the running candidate alive instead of
    // flushing it.
    if (resolvableIds.length === 0 || spanTokenEstimate <= 0) {
      if (activeCandidate && spanTokenEstimate > 0) {
        pendingTransparentTokens += spanTokenEstimate;
      }
      continue;
    }

    const spanStartId = resolvableIds[0]!;
    const spanEndId = resolvableIds[resolvableIds.length - 1]!;

    if (!activeCandidate) {
      activeCandidate = {
        startId: spanStartId,
        endId: spanEndId,
        tokenEstimate: 0,
      };
    }

    // Buffered transparent-span tokens are now interior to the range (they
    // fall between the previous endId and this span's endId), so the splice
    // will remove them and they count as real savings.
    activeCandidate.tokenEstimate += pendingTransparentTokens;
    pendingTransparentTokens = 0;
    activeCandidate.endId = spanEndId;
    activeCandidate.tokenEstimate += spanTokenEstimate;
  }

  pushActiveCandidate();

  const totalCompressibleTokens = candidateRanges.reduce(
    (sum, candidate) => sum + candidate.tokenEstimate,
    0
  );

  candidateRanges.sort((a, b) => {
    if (b.tokenEstimate !== a.tokenEstimate) return b.tokenEstimate - a.tokenEstimate;
    return compareMessageIds(a.startId, b.startId);
  });

  return {
    protectedTailStartId,
    protectedMessageIds,
    protectedBlockIds,
    candidateRanges: candidateRanges.slice(0, Math.max(0, candidateLimit)),
    totalCandidateCount: candidateRanges.length,
    totalCompressibleTokens,
  };
}

/** Render concise hot-tail and candidate-range guidance for the agent. */
export function renderCompressionPlanningHints(
  hints: CompressionPlanningHints,
  options: { includeTailStart?: boolean; includeProtectedIdList?: boolean } = {}
): string {
  const { includeTailStart = true, includeProtectedIdList = false } = options;
  const lines: string[] = [];

  if (includeTailStart && hints.protectedTailStartId) {
    lines.push(`Protected hot tail starts at ${hints.protectedTailStartId}.`);
  }

  if (includeProtectedIdList) {
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
  }

  if (hints.candidateRanges.length > 0) {
    const hiddenCount = Math.max(0, hints.totalCandidateCount - hints.candidateRanges.length);
    const stretchWord = hints.totalCandidateCount === 1 ? "stretch" : "stretches";
    const totalSuffix = `~${hints.totalCompressibleTokens} tokens total across ${hints.totalCandidateCount} ${stretchWord}`;
    const shownSuffix =
      hiddenCount > 0 ? `; showing top ${hints.candidateRanges.length} by size` : "";
    lines.push(`Stale and compressible now (${totalSuffix}${shownSuffix}):`);
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

function resolveRefForSourceKey(
  state: DcpState | null | undefined,
  sourceKey: string | null | undefined
): string | null {
  if (!state || !sourceKey) return null;
  return (
    state.messageRefSnapshot.get(sourceKey)?.ref ??
    state.messageAliases.bySourceKey.get(sourceKey) ??
    null
  );
}

function resolveRefForTimestamp(
  state: DcpState | null | undefined,
  timestamp: number | null | undefined
): string | null {
  if (!state || timestamp === null || timestamp === undefined || !Number.isFinite(timestamp)) {
    return null;
  }

  const matchingRefs = [...state.messageIdSnapshot.entries()]
    .filter(([, candidateTimestamp]) => candidateTimestamp === timestamp)
    .map(([ref]) => ref)
    .sort(compareMessageIds);
  return matchingRefs[0] ?? null;
}

/**
 * Find the visible ref nearest a block boundary, constrained to the block's
 * own timestamp span. `edge: "start"` returns the earliest visible ref at or
 * after the block start; `edge: "end"` returns the latest at or before the
 * block end. This is the fallback used when a boundary's exact source key /
 * timestamp does not resolve to a ref — most commonly because a `tool-exchange`
 * block's first covered item is the assistant tool-call message, which never
 * receives a visible ref (see injectMessageIds). The toolResult inside the same
 * block does carry a ref, so this recovers an addressable boundary.
 */
function resolveBoundaryRefWithinSpan(
  state: DcpState | null | undefined,
  startTimestamp: number,
  endTimestamp: number,
  edge: "start" | "end"
): string | null {
  if (!state || !Number.isFinite(startTimestamp) || !Number.isFinite(endTimestamp)) {
    return null;
  }
  const within = [...state.messageIdSnapshot.entries()]
    .filter(([, timestamp]) => timestamp >= startTimestamp && timestamp <= endTimestamp)
    .sort((a, b) => a[1] - b[1]);
  if (within.length === 0) return null;
  const [ref] = edge === "start" ? within[0]! : within[within.length - 1]!;
  return ref;
}

function resolveExistingBlockBoundaryRefs(
  existing: CompressionBlock,
  state: DcpState | null | undefined
): { startRef: string | null; endRef: string | null } {
  const exactSourceKeys = existing.metadata?.coveredSourceKeys ?? [];
  const exactStartSourceKey = exactSourceKeys[0] ?? existing.startSourceKey ?? null;
  const exactEndSourceKey = exactSourceKeys.at(-1) ?? existing.endSourceKey ?? null;

  return {
    startRef:
      resolveRefForSourceKey(state, exactStartSourceKey) ??
      resolveRefForTimestamp(state, existing.startTimestamp) ??
      resolveBoundaryRefWithinSpan(state, existing.startTimestamp, existing.endTimestamp, "start"),
    endRef:
      resolveRefForSourceKey(state, exactEndSourceKey) ??
      resolveRefForTimestamp(state, existing.endTimestamp) ??
      resolveBoundaryRefWithinSpan(state, existing.startTimestamp, existing.endTimestamp, "end"),
  };
}

function formatExistingBlockBoundaryHint(
  existing: CompressionBlock,
  state: DcpState | null | undefined
): string {
  const { startRef, endRef } = resolveExistingBlockBoundaryRefs(existing, state);
  const rangeRef = startRef && endRef ? `${startRef}..${endRef}` : null;
  const timestampRange = `${existing.startTimestamp}..${existing.endTimestamp}`;

  if (rangeRef) {
    return ` Existing block b${existing.id} spans ${rangeRef} (timestamps ${timestampRange}).`;
  }

  return ` Existing block b${existing.id} spans timestamps ${timestampRange}; visible message refs for its exact boundaries are unavailable.`;
}

function buildOverlapError(
  startId: string,
  endId: string,
  existing: CompressionBlock,
  state?: DcpState | null
): Error {
  return new Error(
    `Overlapping compression ranges are not supported. ` +
      `New range (${startId}..${endId}) overlaps existing block ` +
      `b${existing.id} "${existing.topic}". ` +
      `${formatExistingBlockBoundaryHint(existing, state)} ` +
      `Do not retry the same range: choose a range entirely outside b${existing.id}'s span, ` +
      `or include b${existing.id} explicitly by using boundary ref b${existing.id} and a matching (b${existing.id}) placeholder in the summary.`
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
  ignoredBlockIds: Set<number> = new Set(),
  state?: DcpState | null
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
      throw buildOverlapError(startId, endId, existing, state);
    }

    let coveredCount = 0;
    for (const sourceKey of existingCoveredSourceKeys) {
      if (newCoveredSourceKeySet.has(sourceKey)) coveredCount++;
    }

    if (coveredCount === existingCoveredSourceKeys.size) {
      supersededBlockIds.push(existing.id);
      continue;
    }

    throw buildOverlapError(startId, endId, existing, state);
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
