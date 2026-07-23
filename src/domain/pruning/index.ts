import type {
  DcpState,
  HeuristicPruneDecision,
  PrunedToolAction,
  ToolRecord,
} from "../../types/state.js";
import type { CustomStrategyRule, DcpConfig } from "../../types/config.js";
import type { DcpMessage } from "../../types/message.js";
import { stripDcpHallucinationsFromString } from "../refs/metadata.js";
import { renderCompressedBlockMessage } from "../compression/materialize.js";
import { allocateMessageRef } from "../refs/index.js";
import {
  INTERNAL_BLOCK_ID,
  buildBlockOwnerKey,
  buildSourceItemKey,
  buildSourceOwnerKey,
  countLogicalTurns,
} from "../transcript/index.js";

// Always-protected tool names for deduplication
const ALWAYS_PROTECTED_DEDUP = new Set(["compress", "write", "edit"]);

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

function applyCompressionBlocks(messages: any[], state: DcpState, config: DcpConfig): any[] {
  const activeBlocks = state.compressionBlocks.filter((b) => b.active);
  if (activeBlocks.length === 0) {
    state.tokensSaved = 0;
    return messages;
  }

  const blocksByRecency = [...activeBlocks].sort(
    (a, b) => (b.createdAt ?? b.id) - (a.createdAt ?? a.id)
  );
  const blockDetailById = new Map<number, "full" | "compact" | "minimal">();
  const fullCount = Math.max(0, Math.floor(config.compress.renderFullBlockCount));
  const compactCount = Math.max(0, Math.floor(config.compress.renderCompactBlockCount));

  blocksByRecency.forEach((block, index) => {
    const detailLevel =
      index < fullCount ? "full" : index < fullCount + compactCount ? "compact" : "minimal";
    blockDetailById.set(block.id, detailLevel);
  });

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

    // Build synthetic user message for the compressed block
    const syntheticMsg = {
      ...renderCompressedBlockMessage({
        id: block.id,
        topic: block.topic,
        summary: block.summary,
        activityLogVersion: block.activityLogVersion,
        activityLog: block.activityLog,
        metadata: block.metadata,
        detailLevel: blockDetailById.get(block.id),
      }),
      // anchorTimestamp is always finite (resolveAnchorTimestamp returns
      // endTimestamp + 1 instead of Infinity), but guard against corrupted
      // state from older sessions where Infinity/null could leak in.
      timestamp: Number.isFinite(block.anchorTimestamp)
        ? block.anchorTimestamp - 0.5
        : block.endTimestamp + 0.5,
    };

    // Estimate tokens added by the summary
    const addedTokens = estimateMessageTokens(syntheticMsg);

    // Insert the synthetic message at its source-key anchor when available,
    // falling back to legacy timestamp sorting for restored timestamp-only blocks.
    const anchorIndex = resolveAnchorIndex(messages, block);
    if (anchorIndex !== null) {
      messages.splice(anchorIndex, 0, syntheticMsg);
    } else {
      messages.push(syntheticMsg);
      messages.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
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

// Fixed tombstone strings that replace a pruned tool result's content. Defined
// once so the heuristic-pruning net-savings gate can subtract their token cost
// from each candidate's saved tokens (a tombstone is not free).
const ERROR_TOMBSTONE_TEXT = "[Error output removed - tool failed more than N turns ago]";
const OUTPUT_TOMBSTONE_TEXT =
  "[Output removed to save context - information superseded or no longer needed]";
const ERROR_TOMBSTONE_TOKENS = estimateTokens(ERROR_TOMBSTONE_TEXT);
const OUTPUT_TOMBSTONE_TOKENS = estimateTokens(OUTPUT_TOMBSTONE_TEXT);

/**
 * A tool result that is eligible to be tombstoned this pass, paired with the
 * net tokens its removal would save (`toolResultTokens - tombstoneTokens`).
 */
interface PruneCandidate {
  toolCallId: string;
  netSaved: number;
  strategy: "dedup" | "error" | "custom";
  renderAction: PrunedToolAction;
  turnIndex: number;
}

function tombstoneTokenCost(isError: boolean): number {
  return isError ? ERROR_TOMBSTONE_TOKENS : OUTPUT_TOMBSTONE_TOKENS;
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
 * Return whether a tool or string argument matches case-insensitive custom-strategy patterns.
 *
 * Supports exact names and `*` globs; omitted names stay protected.
 */
export function toolNameMatches(toolName: string, patterns: string[]): boolean {
  return createToolNameMatcher(patterns)(toolName);
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

    const fp = record.inputFingerprint;
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
        netSaved: record.tokenEstimate - tombstoneTokenCost(record.isError),
        strategy: "dedup",
        renderAction: clearRenderAction(),
        turnIndex: record.turnIndex,
      });
    }
  }
  return candidates;
}

/**
 * Collect error-purge candidates: old error tool outputs eligible for a
 * tombstone this pass. Pure — does not mutate state.
 *
 * Age is measured against the bucketed turn, so eligibility flips only at
 * bucket boundaries (multiples of `pruneCadenceTurns`). With the default
 * cadence of 1 the behavior is identical to measuring against currentTurn.
 */
function collectErrorPurgeCandidates(
  messages: any[],
  state: DcpState,
  config: DcpConfig
): PruneCandidate[] {
  if (!config.strategies.purgeErrors.enabled) return [];

  const protectedTools = new Set(config.strategies.purgeErrors.protectedTools ?? []);
  const turnsThreshold = config.strategies.purgeErrors.turns ?? 3;
  const bucket = bucketedTurn(state.currentTurn, config);

  const candidates: PruneCandidate[] = [];
  for (const msg of messages) {
    if (msg.role !== "toolResult") continue;
    if (!msg.isError) continue;

    const toolName: string = msg.toolName ?? "";
    if (protectedTools.has(toolName)) continue;

    const record = state.toolCalls.get(msg.toolCallId);
    if (!record) continue;
    if (state.prunedToolIds.has(msg.toolCallId)) continue;

    if (bucket - record.turnIndex >= turnsThreshold) {
      candidates.push({
        toolCallId: msg.toolCallId,
        netSaved: record.tokenEstimate - tombstoneTokenCost(true),
        strategy: "error",
        renderAction: clearRenderAction(),
        turnIndex: record.turnIndex,
      });
    }
  }
  return candidates;
}
function toolArgsMatchRule(record: ToolRecord, rule: CustomStrategyRule): boolean {
  if (!rule.args) return true;

  for (const [field, patterns] of Object.entries(rule.args)) {
    const value = record.inputArgs[field];
    if (typeof value !== "string") return false;
    const patternList = Array.isArray(patterns) ? patterns : [patterns];
    if (!toolNameMatches(value, patternList)) return false;
  }
  return true;
}

function findMatchingCustomRule(record: ToolRecord, config: DcpConfig): CustomStrategyRule | null {
  const custom = config.strategies.customStrategies;
  if (!custom.enabled) return null;

  for (const rule of custom.rules) {
    if (!toolNameMatches(record.toolName, rule.tools)) continue;
    if (!toolArgsMatchRule(record, rule)) continue;
    return rule;
  }
  return null;
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
  action: Extract<PrunedToolAction, { action: "reduce" }>
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
    `[... ${removedCount} lines removed by DCP to save context — re-run the tool if needed ...]`,
    ...keptTail,
  ].join("\n");
}

function buildReduceAction(
  rule: CustomStrategyRule
): Extract<PrunedToolAction, { action: "reduce" }> {
  return {
    action: "reduce",
    headLines: normalizeLineCount(rule.keep?.headLines),
    tailLines: normalizeLineCount(rule.keep?.tailLines),
  };
}

/**
 * Collect custom-strategy candidates: old large successful tool outputs eligible
 * for a deterministic clear or reduction this pass. Pure — does not mutate state.
 *
 * Like dedup/error purge, this runs every cadence and is governed by explicit
 * custom-strategy age, the protected recent tail, and the shared cadence +
 * per-item/batch savings gates (it is NOT pressure-gated). It only touches
 * successful results matching the ordered safety-allowlist rules. Replay safety
 * comes from `EQUIVALENCE_CONFIG` disabling it.
 */
function collectCustomStrategyCandidates(
  messages: any[],
  state: DcpState,
  config: DcpConfig
): PruneCandidate[] {
  const customConfig = config.strategies.customStrategies;
  if (!customConfig.enabled) return [];

  const bucket = bucketedTurn(state.currentTurn, config);
  const protectedTailStart = Math.max(0, state.currentTurn - config.compress.protectRecentTurns);

  const candidates: PruneCandidate[] = [];
  for (const msg of messages) {
    if (msg.role !== "toolResult" && msg.role !== "bashExecution") continue;

    const record = state.toolCalls.get(msg.toolCallId);
    if (!record) continue;
    if (record.isError) continue;
    const rule = findMatchingCustomRule(record, config);
    if (!rule) continue;
    const minResultTokens = Math.max(
      0,
      Math.floor(rule.minResultTokens ?? customConfig.defaults.minResultTokens ?? 0)
    );
    const minAgeTurns = Math.max(
      0,
      Math.floor(rule.minAgeTurns ?? customConfig.defaults.minAgeTurns ?? 0)
    );
    if (record.tokenEstimate < minResultTokens) continue;
    if (record.turnIndex >= bucket) continue;
    if (bucket - record.turnIndex < minAgeTurns) continue;
    if (record.turnIndex >= protectedTailStart) continue;
    if (state.prunedToolIds.has(msg.toolCallId)) continue;

    const renderAction = rule.action === "reduce" ? buildReduceAction(rule) : clearRenderAction();
    const keptTokens =
      renderAction.action === "reduce"
        ? estimateTokens(buildReducedText(extractToolResultText(msg), renderAction))
        : tombstoneTokenCost(false);
    if (renderAction.action === "reduce") {
      const lineCount = extractToolResultText(msg).split("\n").length;
      if (renderAction.headLines + renderAction.tailLines >= lineCount) continue;
    }

    candidates.push({
      toolCallId: msg.toolCallId,
      netSaved: record.tokenEstimate - keptTokens,
      strategy: "custom",
      renderAction,
      turnIndex: record.turnIndex,
    });
  }
  return candidates;
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

/**
 * Gate and commit heuristic output rewrites (dedup + error purge + custom strategies) for this pass.
 * Mutates state.prunedToolIds / totalPruneCount / pendingSave.
 *
 * Two opt-in net-savings gates decide whether the prefix-cache break is worth
 * it (mirroring Anthropic's `clear_at_least`):
 *  - per-item (`minPruneItemSavedTokens`): drop candidates that don't
 *    individually clear the bar (e.g. tiny 20-token outputs).
 *  - batch (`minPruneBatchSavedTokens`): refuse to rewrite old context unless
 *    the whole flush nets at least this many tokens.
 *
 * Both default to `0` (gates off → every eligible candidate commits, identical
 * to the legacy unconditional behavior). Both are bypassed when the live
 * effective context is in the red zone: under pressure we reclaim space and
 * ignore cache efficiency.
 */
function commitHeuristicPruning(
  messages: any[],
  state: DcpState,
  config: DcpConfig
): HeuristicPruneDecision | null {
  const dedup = collectDeduplicationCandidates(messages, state, config);
  const errors = collectErrorPurgeCandidates(messages, state, config);
  const custom = collectCustomStrategyCandidates(messages, state, config);
  const collected = [...dedup, ...errors, ...custom];
  if (collected.length === 0) return null;

  // Dedupe by toolCallId (a duplicated error result can appear in both lists);
  // first occurrence wins, preserving dedup-before-error-purge precedence.
  const candidates: PruneCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of collected) {
    if (seen.has(candidate.toolCallId)) continue;
    seen.add(candidate.toolCallId);
    candidates.push(candidate);
  }

  const redZone = isHeuristicPruneRedZone(state, config);
  const minItem = Math.max(0, Math.floor(config.strategies.minPruneItemSavedTokens ?? 0));
  const minBatch = Math.max(0, Math.floor(config.strategies.minPruneBatchSavedTokens ?? 0));
  const cadenceBucket = bucketedTurn(state.currentTurn, config);
  const customClearedCandidates = custom.filter(
    (candidate) => candidate.renderAction.action === "clear"
  ).length;
  const customReducedCandidates = custom.filter(
    (candidate) => candidate.renderAction.action === "reduce"
  ).length;

  // Per-item gate (opt-in, bypassed in the red zone).
  const kept =
    minItem > 0 && !redZone
      ? candidates.filter((candidate) => candidate.netSaved >= minItem)
      : candidates;
  const batchSavedTokens = kept.reduce((sum, candidate) => sum + candidate.netSaved, 0);
  const decision: HeuristicPruneDecision = {
    dedupCandidates: dedup.length,
    errorCandidates: errors.length,
    customCandidates: custom.length,
    customClearedCandidates,
    customReducedCandidates,
    uniqueCandidates: candidates.length,
    keptAfterItemGate: kept.length,
    droppedByItemGate: candidates.length - kept.length,
    batchSavedTokens,
    committed: 0,
    committedByStrategy: { dedup: 0, error: 0, custom: 0 },
    committedByAction: { cleared: 0, reduced: 0 },
    oldestMutatedDepth: 0,
    cadenceBucket,
    minItem,
    minBatch,
    customRuleCount: config.strategies.customStrategies.rules.length,
    heldByBatchGate: false,
    redZone,
  };
  if (kept.length === 0) return decision;

  // Batch gate (opt-in, bypassed in the red zone): hold the entire flush until
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
    state.tokensPruned += Math.max(0, candidate.netSaved);
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
  }

  return decision;
}

/**
 * Apply explicit tool output pruning from state.prunedToolIds.
 * Replaces content of matching toolResult/bashExecution messages in place.
 */
function applyToolOutputPruning(messages: any[], state: DcpState): void {
  for (const msg of messages) {
    if (msg.role !== "toolResult" && msg.role !== "bashExecution") continue;
    if (!state.prunedToolIds.has(msg.toolCallId)) continue;

    const action = state.prunedToolActions.get(msg.toolCallId) ?? clearRenderAction();
    const text =
      action.action === "reduce" && !msg.isError
        ? buildReducedText(extractToolResultText(msg), action)
        : msg.isError
          ? ERROR_TOMBSTONE_TEXT
          : OUTPUT_TOMBSTONE_TEXT;

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
function gcPrunedToolIds(messages: any[], state: DcpState): void {
  if (state.prunedToolIds.size === 0) return;

  const liveToolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "toolResult" && msg.role !== "bashExecution") continue;
    if (typeof msg.toolCallId === "string") {
      liveToolCallIds.add(msg.toolCallId);
    }
  }

  for (const toolCallId of state.prunedToolIds) {
    if (liveToolCallIds.has(toolCallId)) continue;
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
  state.lastHeuristicPruneDecision = commitHeuristicPruning(msgs, state, config);
  applyToolOutputPruning(msgs, state);
  gcPrunedToolIds(msgs, state);
  injectMessageIds(msgs, state);

  return msgs;
}

/**
 * Main transform: applies all pruning and returns modified message array.
 * Called from the `context` event handler.
 */
export function applyPruning(messages: DcpMessage[], state: DcpState, config: DcpConfig): any[] {
  // Deep-clone each message and its content to prevent mutations from
  // affecting the original objects across context events.
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

  return finalizeMaterializedMessages(msgs, state, config, { turnMessages: messages });
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
