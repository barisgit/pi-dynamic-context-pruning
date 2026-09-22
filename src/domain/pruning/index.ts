import type { DcpState, HeuristicPruneDecision, PrunedToolAction } from "../../types/state.js";
import type { DcpConfig } from "../../types/config.js";
import type { DcpMessage } from "../../types/message.js";
import { stripDcpHallucinationsFromString } from "../refs/metadata.js";
import { renderCompressedBlockMessage } from "../compression/materialize.js";
import { allocateMessageRef } from "../refs/index.js";
import {
  buildTranscriptSnapshot,
  INTERNAL_BLOCK_ID,
  INTERNAL_HEADING,
  buildBlockOwnerKey,
  buildSourceItemKey,
  buildSourceOwnerKey,
  countLogicalTurns,
} from "../transcript/index.js";
import {
  collectFoRefAdapterCandidates,
  projectFoRefOuterResult,
  type FoRefAdapterCollection,
  type FoRefBridgeV1,
} from "./fo-ref-adapter.js";

// Always-protected tool names for deduplication
const ALWAYS_PROTECTED_DEDUP = new Set(["compress", "write", "edit", "dcp_recover"]);

// Roles that get message IDs injected. Assistant messages are deliberately
// excluded so DCP does not mutate freshly generated model output and break the
// provider prefix cache on every turn.
const ID_ELIGIBLE_ROLES = new Set(["user", "toolResult", "bashExecution"]);

// Roles that are PI-internal and should pass through unchanged
const PASSTHROUGH_ROLES = new Set(["compaction", "branch_summary", "custom_message"]);
export const INTERNAL_OWNER_KEY = "__dcpOwnerKey";
export const INTERNAL_SOURCE_KEY = "__dcpSourceKey";

import {
  estimateMessageTokens,
  estimateTokens,
  expandCompressionIndexRange,
  resolveCompressionRangeIndices,
} from "../compression/range.js";
export { estimateTokens, resolveCompressionRangeIndices } from "../compression/range.js";

function getMessageSourceKey(message: any, ordinal: number): string {
  return typeof message?.[INTERNAL_SOURCE_KEY] === "string"
    ? message[INTERNAL_SOURCE_KEY]
    : buildSourceItemKey(message, ordinal);
}

function applyFoRefOutputPruning(
  state: DcpState,
  bridge: FoRefBridgeV1 | undefined,
  contexts: FoRefPruningContext[]
): Set<string> {
  const liveCompositeIds = new Set<string>();
  for (const context of contexts) {
    for (const id of context.collection.liveCompositeIds) liveCompositeIds.add(id);
    if (!bridge) continue;
    const projected = projectFoContext(context, bridge, activePrunedActions(state));
    if (projected.status !== "projected") continue;
    context.outerMessage.content = projected.message.content;
    for (const id of projected.ignoredCompositeIds) {
      if (!state.prunedToolIds.delete(id)) continue;
      state.prunedToolActions.delete(id);
      state.pendingSave = true;
    }
  }
  return liveCompositeIds;
}

function resolveCompressionRangeForBlock(
  messages: any[],
  block: DcpState["compressionBlocks"][number]
): { lo: number; hi: number } | null {
  if (block.startSourceKey && block.endSourceKey) {
    const sourceKeys = messages.map((message, ordinal) => getMessageSourceKey(message, ordinal));
    const startIdx = sourceKeys.indexOf(block.startSourceKey);
    const endIdx = sourceKeys.indexOf(block.endSourceKey);
    if (startIdx !== -1 && endIdx !== -1) {
      return expandCompressionIndexRange(
        messages,
        Math.min(startIdx, endIdx),
        Math.max(startIdx, endIdx)
      );
    }
  }

  if (!Number.isFinite(block.startTimestamp) || !Number.isFinite(block.endTimestamp)) return null;
  return resolveCompressionRangeIndices(messages, block.startTimestamp, block.endTimestamp);
}

function resolveAnchorIndex(
  messages: any[],
  block: DcpState["compressionBlocks"][number]
): number | null {
  if (!block.anchorSourceKey) return null;
  if (block.anchorSourceKey.startsWith("tail:")) return messages.length;

  for (let index = 0; index < messages.length; index++) {
    if (getMessageSourceKey(messages[index], index) === block.anchorSourceKey) {
      return index;
    }
  }
  return null;
}

export type RetainedCompressionBlockDetail = "full" | "compact";

/**
 * Rank the canonical block log, then select active blocks in the retained tiers.
 * Retired records still occupy their age positions: committing a checkpoint must
 * not promote forgotten older blocks back into working context.
 * Blocks absent from the returned map still hide their covered source range.
 */
export function selectRetainedCompressionBlockDetails(
  blocks: readonly DcpState["compressionBlocks"][number][],
  renderFullBlockCount: number,
  renderCompactBlockCount: number
): Map<number, RetainedCompressionBlockDetail> {
  const blocksByRecency = [...blocks].sort(
    (a, b) => (b.createdAt ?? b.id) - (a.createdAt ?? a.id) || b.id - a.id
  );
  const fullCount = Math.max(0, Math.floor(renderFullBlockCount));
  const compactCount = Math.max(0, Math.floor(renderCompactBlockCount));
  const retained = new Map<number, RetainedCompressionBlockDetail>();

  blocksByRecency.slice(0, fullCount).forEach((block) => {
    if (block.active) retained.set(block.id, "full");
  });
  blocksByRecency.slice(fullCount, fullCount + compactCount).forEach((block) => {
    if (block.active) retained.set(block.id, "compact");
  });
  return retained;
}

function applyCompressionBlocks(messages: any[], state: DcpState, config: DcpConfig): any[] {
  const activeBlocks = state.compressionBlocks.filter((b) => b.active);
  if (activeBlocks.length === 0) {
    state.tokensSaved = 0;
    return messages;
  }

  const blockDetailById = selectRetainedCompressionBlockDetails(
    state.compressionBlocks,
    config.compress.renderFullBlockCount,
    config.compress.renderCompactBlockCount
  );

  let totalSaved = 0;

  for (const block of activeBlocks) {
    const range = resolveCompressionRangeForBlock(messages, block);
    if (!range) continue;

    const { lo, hi } = range;

    // Estimate tokens removed
    let removedTokens = 0;
    for (let i = lo; i <= hi; i++) {
      removedTokens += estimateMessageTokens(messages[i]);
    }

    // Remove the range (inclusive)
    messages.splice(lo, hi - lo + 1);

    const detailLevel = blockDetailById.get(block.id);
    let addedTokens = 0;
    if (detailLevel) {
      // Build synthetic user message only for a retained full/compact block.
      const syntheticMsg = {
        ...renderCompressedBlockMessage({ ...block, detailLevel }),
        // anchorTimestamp is always finite (resolveAnchorTimestamp returns
        // endTimestamp + 1 instead of Infinity), but guard against corrupted
        // state from older sessions where Infinity/null could leak in.
        timestamp: Number.isFinite(block.anchorTimestamp)
          ? block.anchorTimestamp - 0.5
          : block.endTimestamp + 0.5,
      };

      addedTokens = estimateMessageTokens(syntheticMsg);

      // Insert the synthetic message at its source-key anchor when available,
      // falling back to legacy timestamp sorting for restored timestamp-only blocks.
      const anchorIndex = resolveAnchorIndex(messages, block);
      if (anchorIndex !== null) {
        messages.splice(anchorIndex, 0, syntheticMsg);
      } else {
        messages.push(syntheticMsg);
        messages.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
      }
    }

    // Update the block's current saved-token estimate without double-counting
    // across repeated `context` passes.
    const saved = Math.max(0, removedTokens - addedTokens);
    block.savedTokenEstimate = saved;
    totalSaved += saved;
  }

  state.tokensSaved = totalSaved;
  return messages;
}

/**
 * Remove orphaned toolResult/bashExecution messages whose corresponding
 * assistant toolCall was removed, and strip orphaned toolCall blocks from
 * assistant messages whose toolResult was removed.
 *
 * This is a safety net that runs after all compression blocks are applied.
 */
function repairOrphanedToolPairs(messages: any[]): void {
  // 1. Build set of all toolCall IDs present in assistant messages
  const assistantToolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const content: any[] = Array.isArray(msg.content) ? msg.content : [];
    for (const block of content) {
      if (block.type === "toolCall" && typeof block.id === "string") {
        assistantToolCallIds.add(block.id);
      }
    }
  }

  // 2. Build set of all toolCallIds present in toolResult/bashExecution messages
  const resultToolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "toolResult" && msg.role !== "bashExecution") continue;
    if (typeof msg.toolCallId === "string") {
      resultToolCallIds.add(msg.toolCallId);
    }
  }

  // 3. Remove orphaned toolResult/bashExecution messages (no matching assistant toolCall)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "toolResult" && msg.role !== "bashExecution") continue;
    if (typeof msg.toolCallId === "string" && !assistantToolCallIds.has(msg.toolCallId)) {
      messages.splice(i, 1);
    }
  }

  // 4. Strip orphaned toolCall blocks from assistant messages (no matching toolResult)
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const content: any[] = Array.isArray(msg.content) ? msg.content : [];
    const hasToolCalls = content.some((b: any) => b.type === "toolCall");
    if (!hasToolCalls) continue;

    const filtered = content.filter((block: any) => {
      if (block.type !== "toolCall") return true;
      return typeof block.id === "string" && resultToolCallIds.has(block.id);
    });

    // Only update if we actually removed something
    if (filtered.length !== content.length) {
      // If the assistant has no content left at all, keep at least an empty array
      msg.content = filtered.length > 0 ? filtered : [];
    }
  }
}

/**
 * Bucket the current logical turn onto multiples of `pruneCadenceTurns`.
 *
 * Returns the largest multiple of N less than or equal to currentTurn. This is
 * used as the effective "now" for tombstone-emission decisions so the set of
 * tombstoned tool-call IDs only changes when the bucket boundary advances —
 * keeping the rendered prefix cache-stable between boundaries.
 *
 * Stateless: identical inputs always produce the identical bucket, so a reload
 * cannot trigger a spurious flush.
 */
function bucketedTurn(currentTurn: number, config: DcpConfig): number {
  const cadence = Math.max(1, Math.floor(config.strategies.pruneCadenceTurns ?? 1));
  if (cadence <= 1) return currentTurn;
  return Math.floor(currentTurn / cadence) * cadence;
}

function recoveryCall(id: string): string {
  return `dcp_recover({id:${JSON.stringify(id)}})`;
}

function tombstoneText(id: string, isError: boolean): string {
  return isError
    ? `[Error output removed by DCP; original retained: ${recoveryCall(id)}]`
    : `[Output removed by DCP; original retained: ${recoveryCall(id)}]`;
}

/**
 * A tool result that is eligible to be tombstoned this pass, paired with the
 * net tokens its removal would save (`toolResultTokens - tombstoneTokens`).
 */
interface PruneCandidate {
  toolCallId: string;
  netSaved: number;
  strategy: "dedup";
  renderAction: PrunedToolAction;
  turnIndex: number;
}

function tombstoneTokenCost(id: string, isError: boolean): number {
  return estimateTokens(tombstoneText(id, isError));
}

function clearRenderAction(): PrunedToolAction {
  return { action: "clear" };
}

function compileToolNamePattern(pattern: string): RegExp {
  const escaped = pattern.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
}

/**
 * Build a case-insensitive matcher for clearable tool-name patterns.
 *
 * Patterns are lowercased before matching and support a single glob operator:
 * `*` matches any sequence of characters, including empty. Other regex
 * metacharacters are treated literally, and every pattern is anchored.
 */
export function createToolNameMatcher(patterns: string[]): (toolName: string) => boolean {
  const regexes = patterns.map(compileToolNamePattern);
  return (toolName: string): boolean => {
    const normalized = toolName.toLowerCase();
    return regexes.some((regex) => regex.test(normalized));
  };
}

/**
 * Return whether a tool or string argument matches case-insensitive protection patterns.
 *
 * Supports exact names and `*` globs; omitted names stay protected.
 */
export function toolNameMatches(toolName: string, patterns: string[]): boolean {
  return createToolNameMatcher(patterns)(toolName);
}

function hasOnlyTextContent(message: DcpMessage): boolean {
  return (
    typeof message.content === "string" ||
    (Array.isArray(message.content) &&
      message.content.every((part: any) => part?.type === "text" && typeof part.text === "string"))
  );
}

// These tools contain mixed observations or authored conclusions. Their outer
// responses are never raw-log candidates; supported containers are handled by
// the exposed-result adapter instead. Unknown containers remain intact.
const COMPOSITE_TOOL_NAMES = new Set(["run", "subagent", "workflow"]);
const RECOVERY_TOOL_NAMES = new Set(["dcp_recover"]);

function isProtectedResult(message: DcpMessage, state: DcpState): boolean {
  if (message.role !== "toolResult" && message.role !== "bashExecution") return false;
  const name = state.toolCalls.get(message.toolCallId ?? "")?.toolName ?? message.toolName ?? "";
  const normalizedName = name.toLowerCase();
  return (
    COMPOSITE_TOOL_NAMES.has(normalizedName) ||
    RECOVERY_TOOL_NAMES.has(normalizedName) ||
    !hasOnlyTextContent(message)
  );
}

/**
 * Collect deduplication candidates: redundant tool outputs eligible for a
 * tombstone this pass. Pure — does not mutate state.
 *
 * Only duplicate results that originated in a closed bucket
 * (turnIndex < bucketedTurn) are returned. Duplicates inside the currently-open
 * bucket stay fully rendered until the next bucket boundary, so additions to
 * `prunedToolIds` only happen at multiples of `pruneCadenceTurns`.
 */
function collectDeduplicationCandidates(
  messages: any[],
  state: DcpState,
  config: DcpConfig
): PruneCandidate[] {
  if (!config.strategies.deduplication.enabled) return [];

  const protectedTools = new Set([
    ...ALWAYS_PROTECTED_DEDUP,
    ...(config.strategies.deduplication.protectedTools ?? []),
  ]);

  const bucket = bucketedTurn(state.currentTurn, config);

  // fingerprint → array of toolCallIds in timestamp order
  const fingerprintMap = new Map<string, string[]>();

  for (const msg of messages) {
    if (msg.role !== "toolResult") continue;
    const toolName: string = msg.toolName ?? "";
    if (protectedTools.has(toolName)) continue;

    // Look up the fingerprint from the recorded tool call
    const record = state.toolCalls.get(msg.toolCallId);
    if (!record) continue;

    // Identical requests can observe different file contents, test results or state.
    // Compare the complete visible result and its status, not just the request.
    // Never flatten images or other nontext parts into a text tombstone.
    if (!hasOnlyTextContent(msg)) continue;
    const fp = JSON.stringify([record.inputFingerprint, msg.isError === true, msg.content]);
    if (!fingerprintMap.has(fp)) {
      fingerprintMap.set(fp, []);
    }
    fingerprintMap.get(fp)!.push(msg.toolCallId);
  }

  // For each fingerprint with duplicates, prune all but the last —
  // but only ones whose originating turn falls in a closed bucket.
  const candidates: PruneCandidate[] = [];
  for (const [, ids] of fingerprintMap) {
    if (ids.length <= 1) continue;
    for (let i = 0; i < ids.length - 1; i++) {
      const record = state.toolCalls.get(ids[i]);
      if (!record) continue;
      if (record.turnIndex >= bucket) continue;
      if (state.prunedToolIds.has(ids[i])) continue;
      candidates.push({
        toolCallId: ids[i],
        netSaved: record.tokenEstimate - tombstoneTokenCost(ids[i], record.isError),
        strategy: "dedup",
        renderAction: clearRenderAction(),
        turnIndex: record.turnIndex,
      });
    }
  }
  return candidates;
}

function extractToolResultText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("\n");
}

function normalizeLineCount(value: number | undefined): number {
  return Math.max(0, Math.floor(value ?? 0));
}

function buildReducedText(
  rawText: string,
  action: Extract<PrunedToolAction, { action: "reduce" }>,
  toolCallId: string
): string {
  const lines = rawText.split("\n");
  const headLines = normalizeLineCount(action.headLines);
  const tailLines = normalizeLineCount(action.tailLines);
  const removedCount = Math.max(0, lines.length - headLines - tailLines);
  if (removedCount <= 0) return rawText;

  const keptHead = headLines > 0 ? lines.slice(0, headLines) : [];
  const keptTail = tailLines > 0 ? lines.slice(lines.length - tailLines) : [];
  return [
    ...keptHead,
    `[... ${removedCount} lines removed by DCP; original retained: ${recoveryCall(toolCallId)} ...]`,
    ...keptTail,
  ].join("\n");
}

/**
 * Whether the live effective context observed on the PREVIOUS `context` pass is
 * in the red zone. Used to bypass the net-savings gate so heuristic pruning can
 * reclaim space even when a flush would not otherwise clear the savings bar.
 *
 * `applyPruning` runs before the current pass computes effective context, so we
 * read the prior-pass snapshot stashed on state. Replay and tests never set it,
 * so the red zone defaults to `false` there (deterministic).
 */
function isHeuristicPruneRedZone(state: DcpState, config: DcpConfig): boolean {
  const pct = state.lastEffectiveContextPercent;
  const tokens = state.lastEffectiveContextTokens;
  // No prior-pass signal at all (fresh state / replay): not in the red zone.
  if ((pct === null || pct === undefined) && (tokens === null || tokens === undefined)) {
    return false;
  }
  // percent and tokens are independent red-zone triggers (ORed by
  // exceedsMaxContextLimit). A host that does not report a context window
  // yields a null percent but a known token count, so the absolute-token red
  // zone (compress.maxContextTokens) must still be able to fire. Pass 0 for a
  // missing percent so only the token path can trip in that case.
  return exceedsMaxContextLimit(pct ?? 0, config, tokens);
}

interface FoRefPruningContext {
  outerMessage: DcpMessage;
  outerToolCallId: string;
  collection: Extract<FoRefAdapterCollection, { status: "supported" }>;
  maxVisibleBytes: number;
}

function collectFoRefPruningContexts(
  messages: DcpMessage[],
  state: DcpState,
  bridge: FoRefBridgeV1 | undefined
): FoRefPruningContext[] {
  if (!bridge) return [];
  const contexts: FoRefPruningContext[] = [];
  for (const message of messages) {
    if (
      message.role !== "toolResult" ||
      typeof message.toolCallId !== "string" ||
      !hasOnlyTextContent(message)
    )
      continue;
    const outerRecord = state.toolCalls.get(message.toolCallId);
    if (!outerRecord || outerRecord.toolName.toLowerCase() !== "run") continue;
    const collection = collectFoRefAdapterCandidates({
      bridge,
      outerToolCallId: message.toolCallId,
      details: message.details,
      outerRecord,
    });
    if (collection.status !== "supported") continue;
    for (const record of collection.records) state.toolCalls.set(record.toolCallId, record);
    for (const virtualMessage of collection.messages) {
      if (!isProtectedResult(virtualMessage, state)) continue;
      if (!state.prunedToolIds.delete(virtualMessage.toolCallId ?? "")) continue;
      state.prunedToolActions.delete(virtualMessage.toolCallId ?? "");
      state.pendingSave = true;
    }
    const visibleText = extractToolResultText(message);
    contexts.push({
      outerMessage: message,
      outerToolCallId: message.toolCallId,
      collection,
      maxVisibleBytes: Math.max(1, Buffer.byteLength(visibleText, "utf8")),
    });
  }
  return contexts;
}

function projectFoContext(
  context: FoRefPruningContext,
  bridge: FoRefBridgeV1,
  persistedActions: ReadonlyMap<string, PrunedToolAction>,
  proposedActions?: ReadonlyMap<string, PrunedToolAction>
) {
  return projectFoRefOuterResult({
    bridge,
    outerMessage: context.outerMessage,
    outerToolCallId: context.outerToolCallId,
    details: context.outerMessage.details,
    persistedActions,
    proposedActions,
    maxVisibleBytes: context.maxVisibleBytes,
    maxVisibleEventBytes: context.maxVisibleBytes,
  });
}

function activePrunedActions(state: DcpState): Map<string, PrunedToolAction> {
  const actions = new Map<string, PrunedToolAction>();
  for (const id of state.prunedToolIds) {
    actions.set(id, state.prunedToolActions.get(id) ?? clearRenderAction());
  }
  return actions;
}

function buildOrderedHeuristicMessages(
  messages: DcpMessage[],
  state: DcpState,
  foContexts: FoRefPruningContext[]
): DcpMessage[] {
  const virtualByOuterMessage = new Map<DcpMessage, DcpMessage[]>();
  for (const context of foContexts) {
    virtualByOuterMessage.set(
      context.outerMessage,
      context.collection.messages.filter((message) => !isProtectedResult(message, state))
    );
  }
  const eligibleMessages: DcpMessage[] = [];
  for (const message of messages) {
    if (!isProtectedResult(message, state)) eligibleMessages.push(message);
    eligibleMessages.push(...(virtualByOuterMessage.get(message) ?? []));
  }
  return eligibleMessages;
}

function replacementIdsForError(
  failed: DcpMessage,
  messages: DcpMessage[],
  state: DcpState
): string[] {
  const failedId = failed.toolCallId ?? "";
  const failedRecord = state.toolCalls.get(failedId);
  const failedIndex = messages.indexOf(failed);
  if (!failedRecord || failedIndex < 0) return [];
  const failedResultKey = JSON.stringify([failedRecord.inputFingerprint, true, failed.content]);
  const replacements: string[] = [];
  for (let index = failedIndex + 1; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== "toolResult" || !message.toolCallId) continue;
    const record = state.toolCalls.get(message.toolCallId);
    if (!record || record.inputFingerprint !== failedRecord.inputFingerprint) continue;
    const isDuplicateError =
      message.isError === true &&
      hasOnlyTextContent(message) &&
      JSON.stringify([record.inputFingerprint, true, message.content]) === failedResultKey;
    if (!message.isError || isDuplicateError) replacements.push(message.toolCallId);
  }
  return replacements;
}

function hasRetainedErrorReplacement(
  failed: DcpMessage,
  messages: DcpMessage[],
  state: DcpState,
  selectedIds: ReadonlySet<string>
): boolean {
  return replacementIdsForError(failed, messages, state).some((id) => !selectedIds.has(id));
}

function liftUnsafePersistedErrors(messages: DcpMessage[], state: DcpState): void {
  for (const message of messages) {
    if (message.role !== "toolResult" || !message.isError || !message.toolCallId) continue;
    if (!state.prunedToolIds.has(message.toolCallId)) continue;
    if (hasRetainedErrorReplacement(message, messages, state, state.prunedToolIds)) continue;
    state.prunedToolIds.delete(message.toolCallId);
    state.prunedToolActions.delete(message.toolCallId);
    state.pendingSave = true;
  }
}

function requiredPersistedErrorReplacementIds(
  messages: DcpMessage[],
  state: DcpState
): Set<string> {
  const required = new Set<string>();
  for (const message of messages) {
    if (message.role !== "toolResult" || !message.isError || !message.toolCallId) continue;
    if (!state.prunedToolIds.has(message.toolCallId)) continue;
    for (const id of replacementIdsForError(message, messages, state)) {
      if (!state.prunedToolIds.has(id)) required.add(id);
    }
  }
  return required;
}

/**
 * Gate and commit exact duplicate output removals for this pass.
 * Mutates state.prunedToolIds / totalPruneCount / pendingSave.
 *
 * Two net-savings gates decide whether the prefix-cache break is worth
 * it (mirroring Anthropic's `clear_at_least`):
 *  - per-item (`minPruneItemSavedTokens`): drop candidates that don't
 *    individually clear the bar (e.g. tiny 20-token outputs).
 *  - batch (`minPruneBatchSavedTokens`): refuse to rewrite old context unless
 *    the whole flush nets at least this many tokens.
 *
 * Defaults are 100 tokens per item and 10000 per batch; zero disables a gate.
 * Both are bypassed when the live
 * effective context is in the red zone: under pressure we reclaim space and
 * ignore cache efficiency.
 */
function commitHeuristicPruning(
  eligibleMessages: DcpMessage[],
  state: DcpState,
  config: DcpConfig,
  bridge: FoRefBridgeV1 | undefined,
  foContexts: FoRefPruningContext[]
): HeuristicPruneDecision | null {
  liftUnsafePersistedErrors(eligibleMessages, state);
  // Deprecated purge/custom settings cannot create new actions. Historical
  // actions still render and retain their conservative restoration checks.
  const candidates = collectDeduplicationCandidates(eligibleMessages, state, config);
  if (candidates.length === 0) return null;

  const foContextByCompositeId = new Map<string, FoRefPruningContext>();
  for (const context of foContexts) {
    for (const id of context.collection.liveCompositeIds) foContextByCompositeId.set(id, context);
  }
  const requiredReplacementIds = requiredPersistedErrorReplacementIds(eligibleMessages, state);
  const measurableCandidates = candidates.filter((candidate) => {
    if (requiredReplacementIds.has(candidate.toolCallId)) return false;
    const context = foContextByCompositeId.get(candidate.toolCallId);
    if (!context) return true;
    if (!bridge) return false;
    const projected = projectFoContext(
      context,
      bridge,
      activePrunedActions(state),
      new Map([[candidate.toolCallId, candidate.renderAction]])
    );
    if (
      projected.status !== "projected" ||
      !projected.appliedCompositeIds.includes(candidate.toolCallId)
    )
      return false;
    candidate.netSaved =
      estimateTokens(projected.baselineText) - estimateTokens(projected.projectedText);
    return candidate.netSaved > 0;
  });

  const redZone = isHeuristicPruneRedZone(state, config);
  const minItem = Math.max(0, Math.floor(config.strategies.minPruneItemSavedTokens ?? 0));
  const minBatch = Math.max(0, Math.floor(config.strategies.minPruneBatchSavedTokens ?? 0));
  const cadenceBucket = bucketedTurn(state.currentTurn, config);
  // Per-item gate (bypassed in the red zone).
  const kept =
    minItem > 0 && !redZone
      ? measurableCandidates.filter((candidate) => candidate.netSaved >= minItem)
      : measurableCandidates;
  let batchSavedTokens = kept
    .filter((candidate) => !foContextByCompositeId.has(candidate.toolCallId))
    .reduce((sum, candidate) => sum + candidate.netSaved, 0);
  if (bridge) {
    for (const context of foContexts) {
      const proposed = new Map<string, PrunedToolAction>();
      for (const candidate of kept) {
        if (foContextByCompositeId.get(candidate.toolCallId) === context)
          proposed.set(candidate.toolCallId, candidate.renderAction);
      }
      if (proposed.size === 0) continue;
      const projected = projectFoContext(context, bridge, activePrunedActions(state), proposed);
      if (projected.status !== "projected") continue;
      batchSavedTokens +=
        estimateTokens(projected.baselineText) - estimateTokens(projected.projectedText);
    }
  }
  const decision: HeuristicPruneDecision = {
    dedupCandidates: candidates.length,
    errorCandidates: 0,
    customCandidates: 0,
    customClearedCandidates: 0,
    customReducedCandidates: 0,
    uniqueCandidates: measurableCandidates.length,
    keptAfterItemGate: kept.length,
    droppedByItemGate: measurableCandidates.length - kept.length,
    batchSavedTokens,
    committed: 0,
    committedByStrategy: { dedup: 0, error: 0, custom: 0 },
    committedByAction: { cleared: 0, reduced: 0 },
    oldestMutatedDepth: 0,
    cadenceBucket,
    minItem,
    minBatch,
    customRuleCount: 0,
    heldByBatchGate: false,
    redZone,
  };
  if (kept.length === 0) return decision;

  // Batch gate (bypassed in the red zone): hold the entire flush until
  // a later pass when the accumulated net savings justify a single cache break.
  if (minBatch > 0 && !redZone) {
    if (batchSavedTokens < minBatch) {
      decision.heldByBatchGate = true;
      return decision;
    }
  }

  let oldestCommittedTurn: number | null = null;
  for (const candidate of kept) {
    if (state.prunedToolIds.has(candidate.toolCallId)) continue;
    state.prunedToolIds.add(candidate.toolCallId);
    state.prunedToolActions.set(candidate.toolCallId, candidate.renderAction);
    state.totalPruneCount++;
    state.pendingSave = true;
    decision.committed++;
    decision.committedByStrategy[candidate.strategy]++;
    if (candidate.renderAction.action === "reduce") {
      decision.committedByAction.reduced++;
    } else {
      decision.committedByAction.cleared++;
    }
    oldestCommittedTurn =
      oldestCommittedTurn === null
        ? candidate.turnIndex
        : Math.min(oldestCommittedTurn, candidate.turnIndex);
  }

  if (oldestCommittedTurn !== null) {
    decision.oldestMutatedDepth = Math.max(0, state.currentTurn - oldestCommittedTurn);
    state.tokensPruned += Math.max(0, batchSavedTokens);
  }

  return decision;
}

/**
 * Apply explicit tool output pruning from state.prunedToolIds.
 * Replaces content of matching toolResult/bashExecution messages in place.
 */
function applyToolOutputPruning(
  messages: any[],
  state: DcpState,
  evidenceMessages: DcpMessage[]
): void {
  for (const msg of messages) {
    if (msg.role !== "toolResult" && msg.role !== "bashExecution") continue;
    if (!state.prunedToolIds.has(msg.toolCallId)) continue;
    if (
      isProtectedResult(msg, state) ||
      (msg.isError &&
        !hasRetainedErrorReplacement(msg, evidenceMessages, state, state.prunedToolIds))
    ) {
      // Old sessions may carry whole-container or unresolved-error selections.
      // Lift unsafe selections automatically; canonical history was never deleted.
      state.prunedToolIds.delete(msg.toolCallId);
      state.prunedToolActions.delete(msg.toolCallId);
      state.pendingSave = true;
      continue;
    }

    const action = state.prunedToolActions.get(msg.toolCallId) ?? clearRenderAction();
    const text =
      action.action === "reduce" && !msg.isError
        ? buildReducedText(extractToolResultText(msg), action, msg.toolCallId)
        : tombstoneText(msg.toolCallId, msg.isError === true);

    msg.content = [
      {
        type: "text",
        text,
      },
    ];
  }
}

/**
 * Drop tombstone ids whose result message is no longer present after
 * materialization. Runs after tombstone rendering so still-present ids are
 * applied before stale ids folded away by compression/native compaction are GC'd.
 */
function gcPrunedToolIds(
  messages: any[],
  state: DcpState,
  liveCompositeIds: ReadonlySet<string>,
  foBridgeAvailable: boolean
): void {
  if (state.prunedToolIds.size === 0) return;

  const liveToolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "toolResult" && msg.role !== "bashExecution") continue;
    if (typeof msg.toolCallId === "string") {
      liveToolCallIds.add(msg.toolCallId);
    }
  }

  for (const toolCallId of state.prunedToolIds) {
    if (
      liveToolCallIds.has(toolCallId) ||
      liveCompositeIds.has(toolCallId) ||
      (!foBridgeAvailable && toolCallId.startsWith("fo-ref:v1:"))
    )
      continue;
    state.prunedToolIds.delete(toolCallId);
    state.prunedToolActions.delete(toolCallId);
    state.pendingSave = true;
  }
}

/**
 * Inject sequential message IDs into eligible non-assistant messages.
 *
 * Assistant messages are deliberately skipped: mutating freshly generated model
 * output would break the provider prefix cache on every request. User,
 * toolResult, and bashExecution messages still receive visible refs because they
 * are agent-input boundaries. Updates state.messageIdSnapshot.
 */
function extractBlockOwnerKey(message: any): string | null {
  const blockId = message?.[INTERNAL_BLOCK_ID];
  if (typeof blockId === "number" && Number.isInteger(blockId) && blockId > 0) {
    return buildBlockOwnerKey(blockId);
  }

  const content = message?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("\n")
        : "";
  const match = text.match(/<dcp-block-id>(b\d+)<\/dcp-block-id>/);
  return match?.[1] ? `block:${match[1]}` : null;
}

function stripGeneratedDcpHallucinations(messages: any[]): void {
  for (const msg of messages) {
    const role = msg?.role;
    if (role !== "assistant" && role !== "toolResult" && role !== "bashExecution") continue;

    if (typeof msg.content === "string") {
      msg.content = stripDcpHallucinationsFromString(msg.content);
      continue;
    }

    if (!Array.isArray(msg.content)) continue;
    msg.content = msg.content.map((part: any) => {
      if (!part || typeof part !== "object") return part;
      const clone = { ...part };
      if (typeof clone.text === "string") clone.text = stripDcpHallucinationsFromString(clone.text);
      if (typeof clone.input === "string")
        clone.input = stripDcpHallucinationsFromString(clone.input);
      return clone;
    });
  }
}

export function injectMessageIds(messages: any[], state: DcpState): void {
  state.messageRefSnapshot.clear();
  state.messageIdSnapshot.clear();
  state.messageOwnerSnapshot.clear();

  for (let ordinal = 0; ordinal < messages.length; ordinal++) {
    const msg = messages[ordinal];
    if (msg?.[INTERNAL_HEADING]) continue;
    const role: string = msg.role ?? "";

    // Skip PI-internal passthrough messages
    if (PASSTHROUGH_ROLES.has(role)) continue;
    // Skip non-eligible roles
    if (!ID_ELIGIBLE_ROLES.has(role)) continue;

    const sourceKey =
      typeof msg[INTERNAL_SOURCE_KEY] === "string"
        ? msg[INTERNAL_SOURCE_KEY]
        : buildSourceItemKey(msg, ordinal);
    const id = allocateMessageRef(state.messageAliases, sourceKey);
    const ownerKey =
      extractBlockOwnerKey(msg) ??
      (typeof msg[INTERNAL_OWNER_KEY] === "string"
        ? msg[INTERNAL_OWNER_KEY]
        : buildSourceOwnerKey(ordinal));
    const metadataTag = `\n<dcp-id>${id}</dcp-id>`;

    if (role === "user") {
      if (typeof msg.content === "string") {
        msg.content = msg.content + `\n\n<dcp-id>${id}</dcp-id>`;
      } else if (Array.isArray(msg.content)) {
        msg.content = [...msg.content, { type: "text", text: metadataTag }];
      }
    } else if (role === "toolResult" || role === "bashExecution") {
      if (Array.isArray(msg.content)) {
        msg.content = [...msg.content, { type: "text", text: metadataTag }];
      } else if (typeof msg.content === "string") {
        msg.content = msg.content + metadataTag;
      }
    }

    const timestamp =
      typeof msg.timestamp === "number" && Number.isFinite(msg.timestamp) ? msg.timestamp : null;
    state.messageRefSnapshot.set(id, { ref: id, sourceKey, timestamp, ownerKey });
    state.messageOwnerSnapshot.set(id, ownerKey);
    if (timestamp !== null) {
      state.messageIdSnapshot.set(id, timestamp);
    }
  }

  // Transitional compatibility: old prompt examples/tests may still use m001.
  for (const [ref, entry] of state.messageRefSnapshot.entries()) {
    const numeric = Number.parseInt(ref.slice(1), 10);
    if (!Number.isInteger(numeric) || numeric < 1 || numeric > 999) continue;
    const legacyRef = `m${String(numeric).padStart(3, "0")}`;
    if (state.messageRefSnapshot.has(legacyRef)) continue;
    state.messageRefSnapshot.set(legacyRef, { ...entry, ref: legacyRef });
    state.messageOwnerSnapshot.set(legacyRef, entry.ownerKey);
    if (entry.timestamp !== null) {
      state.messageIdSnapshot.set(legacyRef, entry.timestamp);
    }
  }
}

export interface FinalizeMaterializedMessagesOptions {
  /** Source transcript used to preserve logical-turn semantics after materialization. */
  turnMessages?: DcpMessage[];
  /** Internal owner keys, index-aligned with messages. */
  messageOwnerKeys?: readonly string[];
  /** Stable source keys, index-aligned with messages. */
  messageSourceKeys?: readonly string[];
  /** Optional fo bridge injected by the application layer. */
  foRefBridge?: FoRefBridgeV1;
}

/**
 * Apply shared post-materialization pruning steps to an already materialized
 * transcript. This lets the v2 span materializer reuse the v1 safety net,
 * strategy pruning, explicit tool-output pruning, and visible-ref injection
 * without rerunning timestamp compression blocks.
 */
export function finalizeMaterializedMessages(
  messages: DcpMessage[],
  state: DcpState,
  config: DcpConfig,
  options: FinalizeMaterializedMessagesOptions = {}
): DcpMessage[] {
  messages = messages.filter((message) => !(message as any)?.[INTERNAL_HEADING]);
  const msgs: DcpMessage[] = messages.map((m: DcpMessage, ordinal: number) => {
    const clone = { ...m };
    if (Array.isArray(clone.content)) {
      clone.content = clone.content.map((block: any) =>
        typeof block === "object" && block !== null ? { ...block } : block
      );
    }
    const ownerKey =
      options.messageOwnerKeys?.[ordinal] ??
      (typeof (m as any)[INTERNAL_OWNER_KEY] === "string"
        ? (m as any)[INTERNAL_OWNER_KEY]
        : buildSourceOwnerKey(ordinal));
    const sourceKey =
      options.messageSourceKeys?.[ordinal] ??
      (typeof (m as any)[INTERNAL_SOURCE_KEY] === "string"
        ? (m as any)[INTERNAL_SOURCE_KEY]
        : buildSourceItemKey(m, ordinal));

    Object.defineProperty(clone, INTERNAL_OWNER_KEY, {
      value: ownerKey,
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(clone, INTERNAL_SOURCE_KEY, {
      value: sourceKey,
      enumerable: false,
      configurable: true,
    });
    return clone;
  });

  stripGeneratedDcpHallucinations(msgs);
  state.currentTurn = countLogicalTurns(options.turnMessages ?? msgs);
  repairOrphanedToolPairs(msgs);
  const foContexts = collectFoRefPruningContexts(msgs, state, options.foRefBridge);
  const heuristicMessages = buildOrderedHeuristicMessages(msgs, state, foContexts);
  state.lastHeuristicPruneDecision = commitHeuristicPruning(
    heuristicMessages,
    state,
    config,
    options.foRefBridge,
    foContexts
  );
  applyToolOutputPruning(msgs, state, heuristicMessages);
  const liveCompositeIds = applyFoRefOutputPruning(state, options.foRefBridge, foContexts);
  gcPrunedToolIds(msgs, state, liveCompositeIds, options.foRefBridge !== undefined);
  injectMessageIds(msgs, state);

  return msgs;
}

/**
 * Main transform: applies all pruning and returns modified message array.
 * Called from the `context` event handler.
 */
export function applyPruning(
  messages: DcpMessage[],
  state: DcpState,
  config: DcpConfig,
  options: Pick<FinalizeMaterializedMessagesOptions, "foRefBridge"> = {}
): any[] {
  // Deep-clone each message and its content to prevent mutations from
  // affecting the original objects across context events.
  messages = messages.filter((message) => !(message as any)?.[INTERNAL_HEADING]);
  const msgs: DcpMessage[] = messages.map((m: DcpMessage, ordinal: number) => {
    const clone = { ...m };
    if (Array.isArray(clone.content)) {
      clone.content = clone.content.map((block: any) =>
        typeof block === "object" && block !== null ? { ...block } : block
      );
    }
    Object.defineProperty(clone, INTERNAL_OWNER_KEY, {
      value: buildSourceOwnerKey(ordinal),
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(clone, INTERNAL_SOURCE_KEY, {
      value: buildSourceItemKey(m, ordinal),
      enumerable: false,
      configurable: true,
    });
    return clone;
  });

  // 0. Strip generated DCP/protocol hallucinations before they can affect metadata.
  stripGeneratedDcpHallucinations(msgs);

  // 1. Count logical turns → update state.currentTurn.
  // A standalone visible message counts as one turn; an assistant tool batch
  // grouped with its matching tool results counts as one turn.
  state.currentTurn = countLogicalTurns(msgs);

  // 2. Apply active compression blocks
  applyCompressionBlocks(msgs, state, config);

  return finalizeMaterializedMessages(msgs, state, config, {
    turnMessages: messages,
    ...options,
  });
}

/**
 * Determine if a nudge should fire and return the nudge type, or null.
 *
 * Policy:
 * - only when context usage is above the configured minimum threshold
 * - debounced by logical turns, not raw `context` event cadence
 * - suppressed immediately after a successful compress until enough newer logical
 *   turns have happened
 */
export function exceedsMaxContextLimit(
  contextPercent: number,
  config: DcpConfig,
  contextTokens?: number | null
): boolean {
  if (contextPercent > config.compress.maxContextPercent) return true;
  const maxTokens = config.compress.maxContextTokens;
  return typeof maxTokens === "number" && contextTokens !== null && contextTokens !== undefined
    ? contextTokens > maxTokens
    : false;
}

export function resolveEffectiveContextSize(
  hostTokens: number | null | undefined,
  dcpEstimatedTokens: number,
  contextWindow: number | null | undefined
): { effectiveTokens: number; effectivePercent: number | null } {
  const host = Number.isFinite(hostTokens as number) ? Math.max(0, hostTokens as number) : 0;
  const dcp = Number.isFinite(dcpEstimatedTokens) ? Math.max(0, dcpEstimatedTokens) : 0;
  const effectiveTokens = Math.max(host, dcp);
  const effectivePercent =
    typeof contextWindow === "number" && contextWindow > 0 ? effectiveTokens / contextWindow : null;
  return { effectiveTokens, effectivePercent };
}

function reachesMinContextLimit(
  contextPercent: number,
  config: DcpConfig,
  contextTokens?: number | null
): boolean {
  if (contextPercent >= config.compress.minContextPercent) return true;
  const minTokens = config.compress.minContextTokens;
  return typeof minTokens === "number" && contextTokens !== null && contextTokens !== undefined
    ? contextTokens >= minTokens
    : false;
}

export function getNudgeType(
  contextPercent: number,
  state: DcpState,
  config: DcpConfig,
  toolCallsSinceLastUser: number,
  contextTokens?: number | null
): "context-strong" | "context-soft" | "turn" | "iteration" | null {
  const { nudgeDebounceTurns, nudgeForce, iterationNudgeThreshold } = config.compress;
  const debounceTurns = Math.max(1, nudgeDebounceTurns);

  if (!reachesMinContextLimit(contextPercent, config, contextTokens)) {
    return null;
  }

  // A successful compress should buy immediate quiet. Do not nudge again in
  // the same logical turn that already produced a compress.
  if (state.currentTurn <= state.lastCompressTurn) {
    return null;
  }

  // Debounce by logical turns rather than by raw context passes.
  if (state.lastNudgeTurn >= 0 && state.currentTurn - state.lastNudgeTurn < debounceTurns) {
    return null;
  }

  if (exceedsMaxContextLimit(contextPercent, config, contextTokens)) {
    return nudgeForce === "strong" ? "context-strong" : "context-soft";
  }

  if (toolCallsSinceLastUser >= iterationNudgeThreshold) {
    return "iteration";
  }

  return "turn";
}
