// ---------------------------------------------------------------------------
// DCP replay engine
// ---------------------------------------------------------------------------
//
// Reconstructs a `DcpState` from a session's branch entries by replaying the
// material DCP events embedded in the transcript:
//   1. Tool-call / tool-result pairs feed `state.toolCalls` (used by dedup &
//      error-purge).
//   2. Successful `compress` tool calls produce `CompressionBlock`s identical
//      to those the live execute path would have created.
//   3. `compaction` entries with `details.source === "dcp-native-compaction"`
//      deactivate their represented blocks and bake savings into
//      `lifetimeTokensSavedRealized`.
//
// After the walk, `applyPruning` is called once so logical-turn counting,
// dedup tombstones, and error-purge tombstones land just as they would on a
// normal `context` pass.
//
// Soft compatibility: malformed entries are skipped, not thrown. Real-world
// sessions contain branch_summary/custom/etc. entries that have no DCP
// significance.

import { createInputFingerprint } from "../../state.js";
import { createState } from "../../state.js";
import type { DcpConfig } from "../../types/config.js";
import type { DcpMessage } from "../../types/message.js";
import type { CompressionBlock, DcpState } from "../../types/state.js";
import {
  buildCompressionArtifactsForRange,
  expandBlockPlaceholders,
  resolveAnchorSourceKey,
  resolveAnchorTimestamp,
  resolveIdToSourceKey,
  resolveIdToTimestamp,
  resolveSupersededBlockIdsForRange,
  validateCompressionRangeBoundaryIds,
} from "../compression/tooling.js";
import { renderCompressedBlockMessage } from "../compression/materialize.js";
import { applyPruning } from "../pruning/index.js";
import { estimateMessageTokens, estimateTokens } from "../tokens/estimate.js";
import { buildTranscriptSnapshot } from "../transcript/index.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ReplayDcpStateOptions {
  /**
   * Optional pre-allocated state to populate. When omitted, a fresh state is
   * created. The caller is expected to have already called `resetState()` on
   * any supplied state; the engine does not reset.
   */
  state?: DcpState;
}

// ---------------------------------------------------------------------------
// Entry shape helpers
// ---------------------------------------------------------------------------

function isMessageEntry(entry: any): boolean {
  return entry?.type === "message" && entry.message !== undefined && entry.message !== null;
}

function isCompactionEntry(entry: any): boolean {
  return entry?.type === "compaction";
}

function isCustomMessageEntry(entry: any): boolean {
  return entry?.type === "custom_message";
}

function isBranchSummaryEntry(entry: any): boolean {
  return entry?.type === "branch_summary";
}

function getCompactionDetails(entry: any): {
  source: unknown;
  representedBlockIds?: unknown;
} | null {
  const details = entry?.details;
  if (!details || typeof details !== "object") return null;
  return details as { source: unknown; representedBlockIds?: unknown };
}

function isDcpNativeCompactionEntry(entry: any): boolean {
  if (!isCompactionEntry(entry)) return false;
  const details = getCompactionDetails(entry);
  return details?.source === "dcp-native-compaction";
}

function parseTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/**
 * Convert a branch entry into the DCP message shape used by the rest of the
 * pipeline. Returns null for entries that have no in-transcript message.
 */
function entryToMessage(entry: any): any | null {
  if (isMessageEntry(entry)) {
    return entry.message;
  }
  if (isCustomMessageEntry(entry)) {
    return {
      role: "custom_message",
      content: entry.content,
      timestamp: parseTimestamp(entry.timestamp),
    };
  }
  if (isBranchSummaryEntry(entry)) {
    return {
      role: "branch_summary",
      content: [{ type: "text", text: entry.summary }],
      timestamp: parseTimestamp(entry.timestamp),
    };
  }
  if (isCompactionEntry(entry)) {
    return {
      role: "compaction",
      content: [{ type: "text", text: entry.summary }],
      timestamp: parseTimestamp(entry.timestamp),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tool-call bookkeeping
// ---------------------------------------------------------------------------

/**
 * Extract all assistant tool-call blocks from a message and register them in
 * `state.toolCalls`. Mirrors the `tool_call` event hook used at runtime.
 */
function recordAssistantToolCalls(message: any, state: DcpState): void {
  if (message?.role !== "assistant") return;
  const content = Array.isArray(message.content) ? message.content : [];
  for (const block of content) {
    if (block?.type !== "toolCall") continue;
    const toolCallId = block.id;
    if (typeof toolCallId !== "string" || toolCallId.length === 0) continue;
    if (state.toolCalls.has(toolCallId)) continue;
    const toolName = typeof block.name === "string" ? block.name : "";
    const args = parseArgs(block.arguments);
    state.toolCalls.set(toolCallId, {
      toolCallId,
      toolName,
      inputArgs: args,
      inputFingerprint: createInputFingerprint(toolName, args),
      isError: false,
      turnIndex: state.currentTurn,
      timestamp: 0,
      tokenEstimate: 0,
    });
  }
}

/**
 * Update or create a `ToolRecord` for a toolResult message. Mirrors the
 * `tool_result` event hook used at runtime.
 */
function recordToolResult(message: any, state: DcpState): void {
  if (message?.role !== "toolResult") return;
  const toolCallId = message.toolCallId;
  if (typeof toolCallId !== "string" || toolCallId.length === 0) return;
  const outputText = Array.isArray(message.content)
    ? message.content
        .map((part: any) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
        .join("")
    : "";
  const tokenEstimate = estimateTokens(outputText);
  const timestamp = parseTimestamp(message.timestamp);
  const isError = Boolean(message.isError);

  const existing = state.toolCalls.get(toolCallId);
  if (existing) {
    existing.isError = isError;
    existing.timestamp = timestamp;
    existing.tokenEstimate = tokenEstimate;
    return;
  }

  const toolName = typeof message.toolName === "string" ? message.toolName : "";
  state.toolCalls.set(toolCallId, {
    toolCallId,
    toolName,
    inputArgs: {},
    inputFingerprint: createInputFingerprint(toolName, {}),
    isError,
    turnIndex: state.currentTurn,
    timestamp,
    tokenEstimate,
  });
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

// ---------------------------------------------------------------------------
// Compress replay
// ---------------------------------------------------------------------------

interface CompressRange {
  startId: string;
  endId: string;
  summary: string;
  topic?: string;
}

interface CompressInvocation {
  toolCallId: string;
  topic?: string;
  ranges: CompressRange[];
}

/**
 * Locate the assistant `compress` toolCall block whose id matches the given
 * toolCallId. We search the in-flight message buffer because the compress
 * arguments object is the authoritative input we must replay against — the
 * tool-result text is human-facing and not reliable.
 */
function findCompressInvocation(
  messages: readonly any[],
  toolCallId: string
): CompressInvocation | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const block of content) {
      if (block?.type !== "toolCall") continue;
      if (block.id !== toolCallId) continue;
      if (block.name !== "compress") return null;
      const args = parseArgs(block.arguments);
      const rawRanges = Array.isArray(args.ranges) ? (args.ranges as any[]) : [];
      const ranges: CompressRange[] = [];
      for (const r of rawRanges) {
        if (!r || typeof r !== "object") continue;
        const startId = (r as any).startId;
        const endId = (r as any).endId;
        const summary = (r as any).summary;
        if (typeof startId !== "string" || typeof endId !== "string") continue;
        if (typeof summary !== "string") continue;
        const range: CompressRange = { startId, endId, summary };
        const rTopic = (r as any).topic;
        if (typeof rTopic === "string") range.topic = rTopic;
        ranges.push(range);
      }
      const invocation: CompressInvocation = { toolCallId, ranges };
      if (typeof args.topic === "string") invocation.topic = args.topic;
      return invocation;
    }
  }
  return null;
}

function resolveEffectiveTopic(range: CompressRange, defaultTopic?: string): string | null {
  const topic = range.topic ?? defaultTopic;
  const trimmed = topic?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function applyCompressInvocation(
  invocation: CompressInvocation,
  messages: readonly any[],
  state: DcpState,
  config: DcpConfig
): void {
  // Populate the messageId / messageRef snapshots so `mNNNN` boundary refs
  // resolve correctly. `applyPruning` mutates state.currentTurn,
  // state.prunedToolIds, and state.totalPruneCount in addition to the
  // snapshots. That mirrors the live runtime, which runs applyPruning on
  // every `context` pass — so doing it here at every compress boundary keeps
  // the replayed state on the same trajectory as the live state.
  applyPruning(messages as DcpMessage[], state, config);

  const plannedBlocks: CompressionBlock[] = [];
  const pendingSupersededBlockIds = new Set<number>();
  let nextBlockId = state.nextBlockId;

  for (const range of invocation.ranges) {
    const { startId, endId, summary } = range;
    const blockTopic = resolveEffectiveTopic(range, invocation.topic);
    if (!blockTopic) {
      // Live path throws; replay skips this range silently to remain
      // soft-tolerant of weird historical data.
      continue;
    }

    try {
      validateCompressionRangeBoundaryIds(startId, endId, state);
    } catch {
      continue;
    }

    let startTimestamp: number;
    let endTimestamp: number;
    try {
      startTimestamp = resolveIdToTimestamp(startId, "startTimestamp", state);
      endTimestamp = resolveIdToTimestamp(endId, "endTimestamp", state);
    } catch {
      continue;
    }
    if (!Number.isFinite(startTimestamp) || !Number.isFinite(endTimestamp)) continue;
    if (startTimestamp > endTimestamp) continue;

    const anchorTimestamp = resolveAnchorTimestamp(endTimestamp, state);
    const boundaryStartSourceKey = resolveIdToSourceKey(startId, state, "startSourceKey");
    const boundaryEndSourceKey = resolveIdToSourceKey(endId, state, "endSourceKey");
    const expandedSummary = expandBlockPlaceholders(summary, state);
    const artifacts = buildCompressionArtifactsForRange(
      messages as any[],
      state,
      startTimestamp,
      endTimestamp
    );
    const expandedStartSourceKey =
      artifacts.metadata.coveredSourceKeys[0] ?? boundaryStartSourceKey;
    const expandedEndSourceKey =
      artifacts.metadata.coveredSourceKeys.at(-1) ?? boundaryEndSourceKey;
    const anchorSourceKey = resolveAnchorSourceKey(
      endTimestamp,
      expandedEndSourceKey ?? null,
      state
    );
    let supersededBlockIds: number[];
    try {
      supersededBlockIds = resolveSupersededBlockIdsForRange(
        messages as any[],
        [...state.compressionBlocks, ...plannedBlocks],
        startTimestamp,
        endTimestamp,
        artifacts.metadata.coveredSourceKeys,
        startId,
        endId,
        pendingSupersededBlockIds
      );
    } catch {
      // Partial-overlap supersession conflict — live path would have thrown,
      // so this range never produced a block. Skip.
      continue;
    }
    for (const blockId of supersededBlockIds) {
      pendingSupersededBlockIds.add(blockId);
    }
    artifacts.metadata.supersededBlockIds = supersededBlockIds;

    const block: CompressionBlock = {
      id: nextBlockId++,
      topic: blockTopic,
      summary: expandedSummary,
      startTimestamp,
      endTimestamp,
      anchorTimestamp,
      startSourceKey: expandedStartSourceKey,
      endSourceKey: expandedEndSourceKey,
      anchorSourceKey,
      active: true,
      summaryTokenEstimate: estimateTokens(expandedSummary),
      savedTokenEstimate: 0,
      createdAt: parseTimestamp((messages[messages.length - 1] as any)?.timestamp) || Date.now(),
      compressCallId: invocation.toolCallId,
      activityLogVersion: artifacts.activityLogVersion,
      activityLog: artifacts.activityLog,
      metadata: artifacts.metadata,
    };

    plannedBlocks.push(block);
  }

  if (plannedBlocks.length === 0) return;

  state.nextBlockId = nextBlockId;
  for (const existing of state.compressionBlocks) {
    if (pendingSupersededBlockIds.has(existing.id)) {
      existing.active = false;
    }
  }
  state.compressionBlocks.push(...plannedBlocks);
  state.lastCompressTurn = state.currentTurn;
  state.lastNudgeTurn = state.currentTurn;

  // Compute savedTokenEstimate post-creation against the pre-block snapshot,
  // identical to the live path. `messages` is the buffer *before* this
  // compress was rendered, which matches what the live compress observed.
  for (const block of plannedBlocks) {
    block.savedTokenEstimate = estimateCreationSavings(block, messages);
  }
  state.tokensSaved = state.compressionBlocks
    .filter((block) => block.active)
    .reduce((sum, block) => sum + (block.savedTokenEstimate ?? 0), 0);
}

function estimateCreationSavings(
  block: CompressionBlock,
  messages: readonly any[]
): number {
  const coveredSourceKeys = block.metadata?.coveredSourceKeys;
  if (!coveredSourceKeys || coveredSourceKeys.length === 0) return 0;
  const covered = new Set(coveredSourceKeys);
  const snapshot = buildTranscriptSnapshot([...messages]);
  const removed = snapshot.sourceItems.reduce(
    (sum, item) => sum + (covered.has(item.key) ? estimateMessageTokens(item.message) : 0),
    0
  );
  const added = estimateMessageTokens(renderCompressedBlockMessage(block));
  return Math.max(0, removed - added);
}

// ---------------------------------------------------------------------------
// Native compaction replay
// ---------------------------------------------------------------------------

function applyNativeCompaction(entry: any, state: DcpState): void {
  const details = getCompactionDetails(entry);
  if (!details) return;
  const rawIds = (details as any).representedBlockIds;
  const representedBlockIds = new Set<number>(
    Array.isArray(rawIds) ? rawIds.filter((id) => typeof id === "number") : []
  );
  if (representedBlockIds.size === 0) return;

  for (const block of state.compressionBlocks) {
    if (!representedBlockIds.has(block.id)) continue;
    if (!block.active) continue;
    block.active = false;
    state.lifetimeTokensSavedRealized += block.savedTokenEstimate ?? 0;
  }

  state.tokensSaved = state.compressionBlocks
    .filter((block) => block.active)
    .reduce((sum, block) => sum + (block.savedTokenEstimate ?? 0), 0);

  // Native compaction folds the represented coverage into the host's hidden
  // prefix, so the watermarks that previously suppressed nudges are no longer
  // meaningful. Reset them to match the live session_compact hook.
  state.lastCompressTurn = -1;
  state.lastNudgeTurn = -1;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Replay DCP state from a session's branch entries.
 *
 * The engine walks `branchEntries` in order, maintaining an in-flight
 * `messages` buffer. Each entry is classified:
 *   - message entries (and custom_message / branch_summary / compaction) are
 *     appended to the buffer.
 *   - assistant messages additionally register their toolCall blocks in
 *     `state.toolCalls`.
 *   - toolResult messages update the matching `ToolRecord`.
 *   - successful `compress` tool results trigger block construction against
 *     the buffer-snapshot just before that result.
 *   - dcp-native-compaction entries deactivate represented blocks and bake
 *     their savings.
 *
 * After the walk, `applyPruning` runs once more to finalize logical-turn
 * counting, dedup tombstones, and error-purge tombstones.
 */
export function replayDcpState(
  branchEntries: readonly any[],
  config: DcpConfig,
  options: ReplayDcpStateOptions = {}
): DcpState {
  const state = options.state ?? createState();
  const messages: any[] = [];

  for (const entry of branchEntries) {
    const message = entryToMessage(entry);
    if (message === null) {
      // Non-message entry that isn't a recognised transcript shape (e.g.
      // dcp-state custom entries from legacy persistence). Skip — replay
      // does not depend on them.
      continue;
    }

    if (message.role === "assistant") {
      recordAssistantToolCalls(message, state);
    }

    messages.push(message);

    if (message.role === "toolResult") {
      recordToolResult(message, state);
      const toolCallId = message.toolCallId;
      const isError = Boolean(message.isError);
      const isCompressSuccess =
        typeof toolCallId === "string" &&
        !isError &&
        (message.toolName === "compress" ||
          state.toolCalls.get(toolCallId)?.toolName === "compress");

      if (isCompressSuccess) {
        const invocation = findCompressInvocation(messages, toolCallId);
        // The compress result is included in `messages` already; the live
        // execute path saw messages *before* the result, so replay against
        // the buffer-without-this-toolResult.
        const messagesBeforeResult = messages.slice(0, messages.length - 1);
        if (invocation) {
          applyCompressInvocation(invocation, messagesBeforeResult, state, config);
        }
      }
    }

    if (isDcpNativeCompactionEntry(entry)) {
      applyNativeCompaction(entry, state);
    }
  }

  // Final finalization pass: ensures currentTurn and prune tombstones reflect
  // the entire buffer, not just the state at the last compress boundary.
  applyPruning(messages as DcpMessage[], state, config);

  state.pendingSave = false;
  return state;
}
