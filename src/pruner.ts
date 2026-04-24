import type { DcpState } from "./state.js";
import type { DcpConfig } from "./config.js";
import type { DcpMessage } from "./types/message.js";
import { stripDcpHallucinationsFromString } from "./dcp-metadata.js";
import { renderCompressedBlockMessage } from "./materialize.js";
import { allocateMessageRef } from "./message-refs.js";
import { buildSourceItemKey, buildSourceOwnerKey, countLogicalTurns } from "./transcript.js";

// Always-protected tool names for deduplication
const ALWAYS_PROTECTED_DEDUP = new Set(["compress", "write", "edit"]);

// Roles that get message IDs injected
const ID_ELIGIBLE_ROLES = new Set(["user", "assistant", "toolResult", "bashExecution"]);

// Roles that are PI-internal and should pass through unchanged
const PASSTHROUGH_ROLES = new Set(["compaction", "branch_summary", "custom_message"]);
const INTERNAL_OWNER_KEY = "__dcpOwnerKey";
const INTERNAL_SOURCE_KEY = "__dcpSourceKey";

/**
 * Simple token estimator: chars / 4, rounded.
 */
export function estimateTokens(text: string): number {
  return Math.round(text.length / 4);
}

/**
 * Estimate tokens from a message's content, whatever shape it takes.
 */
function estimateMessageTokens(msg: any): number {
  if (!msg) return 0;
  const content = msg.content;
  if (!content) return 0;
  if (typeof content === "string") return estimateTokens(content);
  if (Array.isArray(content)) {
    let total = 0;
    for (const part of content) {
      if (part && typeof part === "object") {
        if (typeof part.text === "string") total += estimateTokens(part.text);
        else if (typeof part.thinking === "string") total += estimateTokens(part.thinking);
        else if (part.type === "image") total += 500; // rough estimate for images
      }
    }
    return total;
  }
  return 0;
}

/**
 * Resolve the inclusive message index range covered by a timestamp-bounded
 * compression block, including the same assistant/tool-result expansion rules
 * used by the live pruning path.
 */
function expandCompressionIndexRange(messages: any[], initialLo: number, initialHi: number): { lo: number; hi: number } {
  let lo = initialLo;
  let hi = initialHi;

  // Expand lo backward: if there is an assistant before lo whose tool_use
  // blocks have matching tool_results inside [lo..hi], pull the entire
  // assistant + any intermediate result messages into the range so the
  // group is always removed atomically.
  while (lo > 0) {
    let scanIdx = lo - 1;
    while (scanIdx >= 0) {
      const r = (messages[scanIdx] as any).role as string;
      if (r !== "toolResult" && r !== "bashExecution" && !PASSTHROUGH_ROLES.has(r)) break;
      scanIdx--;
    }
    if (scanIdx < 0 || (messages[scanIdx] as any).role !== "assistant") break;

    const prev = messages[scanIdx] as any;
    const toolCallIdsInRange = new Set<string>();
    for (let i = lo; i <= hi; i++) {
      const m = messages[i] as any;
      if (
        (m.role === "toolResult" || m.role === "bashExecution") &&
        typeof m.toolCallId === "string"
      ) {
        toolCallIdsInRange.add(m.toolCallId);
      }
    }
    const prevContent: any[] = Array.isArray(prev.content) ? prev.content : [];
    const hasMatchingToolCalls = prevContent.some(
      (block: any) => block.type === "toolCall" && toolCallIdsInRange.has(block.id)
    );
    if (!hasMatchingToolCalls) break;
    lo = scanIdx;
  }

  // Expand hi forward: for every assistant message in [lo..hi] that has
  // tool_use blocks, include any immediately-following tool_result messages
  // that correspond to those blocks.
  let prevHi: number;
  do {
    prevHi = hi;
    const assistantToolCallIds = new Set<string>();
    for (let i = lo; i <= hi; i++) {
      const m = messages[i] as any;
      if (m.role !== "assistant") continue;
      const content: any[] = Array.isArray(m.content) ? m.content : [];
      for (const block of content) {
        if (block.type === "toolCall" && typeof block.id === "string") {
          assistantToolCallIds.add(block.id);
        }
      }
    }
    while (hi + 1 < messages.length) {
      const next = messages[hi + 1] as any;
      if (
        (next.role === "toolResult" || next.role === "bashExecution") &&
        assistantToolCallIds.has(next.toolCallId)
      ) {
        hi++;
      } else if (PASSTHROUGH_ROLES.has(next.role)) {
        hi++;
      } else {
        break;
      }
    }
  } while (hi !== prevHi);

  return { lo, hi };
}

export function resolveCompressionRangeIndices(
  messages: DcpMessage[],
  startTimestamp: number,
  endTimestamp: number,
): { lo: number; hi: number } | null {
  const startIdx = messages.findIndex((m) => m.timestamp === startTimestamp);
  const endIdx = messages.findIndex((m) => m.timestamp === endTimestamp);

  if (startIdx === -1 || endIdx === -1) return null;

  return expandCompressionIndexRange(
    messages,
    Math.min(startIdx, endIdx),
    Math.max(startIdx, endIdx),
  );
}

/**
 * Apply active compression blocks to the message array.
 * Mutates messages in place (via splice/sort) and returns it.
 */
function getMessageSourceKey(message: any, ordinal: number): string {
  return typeof message?.[INTERNAL_SOURCE_KEY] === "string"
    ? message[INTERNAL_SOURCE_KEY]
    : buildSourceItemKey(message, ordinal)
}

function resolveCompressionRangeForBlock(messages: any[], block: DcpState["compressionBlocks"][number]): { lo: number; hi: number } | null {
  if (block.startSourceKey && block.endSourceKey) {
    const sourceKeys = messages.map((message, ordinal) => getMessageSourceKey(message, ordinal))
    const startIdx = sourceKeys.indexOf(block.startSourceKey)
    const endIdx = sourceKeys.indexOf(block.endSourceKey)
    if (startIdx !== -1 && endIdx !== -1) {
      return expandCompressionIndexRange(
        messages,
        Math.min(startIdx, endIdx),
        Math.max(startIdx, endIdx),
      )
    }
  }

  if (!Number.isFinite(block.startTimestamp) || !Number.isFinite(block.endTimestamp)) return null
  return resolveCompressionRangeIndices(messages, block.startTimestamp, block.endTimestamp)
}

function resolveAnchorIndex(messages: any[], block: DcpState["compressionBlocks"][number]): number | null {
  if (!block.anchorSourceKey) return null
  if (block.anchorSourceKey.startsWith("tail:")) return messages.length

  for (let index = 0; index < messages.length; index++) {
    if (getMessageSourceKey(messages[index], index) === block.anchorSourceKey) {
      return index
    }
  }
  return null
}

function applyCompressionBlocks(messages: any[], state: DcpState, config: DcpConfig): any[] {
  const activeBlocks = state.compressionBlocks.filter((b) => b.active);
  if (activeBlocks.length === 0) {
    state.tokensSaved = 0;
    return messages;
  }

  const blocksByRecency = [...activeBlocks].sort(
    (a, b) => (b.createdAt ?? b.id) - (a.createdAt ?? a.id),
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
        detailLevel: blockDetailById.get(block.id),
      }),
      // anchorTimestamp is always finite (resolveAnchorTimestamp returns
      // endTimestamp + 1 instead of Infinity), but guard against corrupted
      // state from older sessions where Infinity/null could leak in.
      timestamp: Number.isFinite(block.anchorTimestamp) ? block.anchorTimestamp - 0.5 : block.endTimestamp + 0.5,
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
 * Apply deduplication: mark redundant tool outputs for pruning.
 * Mutates state.prunedToolIds.
 */
function applyDeduplication(messages: any[], state: DcpState, config: DcpConfig): void {
  if (!config.strategies.deduplication.enabled) return;
  if (state.manualMode && !config.manualMode.automaticStrategies) return;

  const protectedTools = new Set([
    ...ALWAYS_PROTECTED_DEDUP,
    ...(config.strategies.deduplication.protectedTools ?? []),
  ]);

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

  // For each fingerprint with duplicates, prune all but the last
  for (const [, ids] of fingerprintMap) {
    if (ids.length <= 1) continue;
    // Keep the last one; prune the rest
    for (let i = 0; i < ids.length - 1; i++) {
      state.prunedToolIds.add(ids[i]);
      state.totalPruneCount++;
    }
  }
}

/**
 * Apply error purging: mark old error tool outputs for pruning.
 * Mutates state.prunedToolIds.
 */
function applyErrorPurging(messages: any[], state: DcpState, config: DcpConfig): void {
  if (!config.strategies.purgeErrors.enabled) return;
  if (state.manualMode && !config.manualMode.automaticStrategies) return;

  const protectedTools = new Set(config.strategies.purgeErrors.protectedTools ?? []);
  const turnsThreshold = config.strategies.purgeErrors.turns ?? 3;

  for (const msg of messages) {
    if (msg.role !== "toolResult") continue;
    if (!msg.isError) continue;

    const toolName: string = msg.toolName ?? "";
    if (protectedTools.has(toolName)) continue;

    const record = state.toolCalls.get(msg.toolCallId);
    if (!record) continue;

    if (state.currentTurn - record.turnIndex >= turnsThreshold) {
      state.prunedToolIds.add(msg.toolCallId);
      state.totalPruneCount++;
    }
  }
}

/**
 * Apply explicit tool output pruning from state.prunedToolIds.
 * Replaces content of matching toolResult messages in place.
 */
function applyToolOutputPruning(messages: any[], state: DcpState): void {
  for (const msg of messages) {
    if (msg.role !== "toolResult") continue;
    if (!state.prunedToolIds.has(msg.toolCallId)) continue;

    if (msg.isError) {
      msg.content = [
        {
          type: "text",
          text: "[Error output removed - tool failed more than N turns ago]",
        },
      ];
    } else {
      msg.content = [
        {
          type: "text",
          text: "[Output removed to save context - information superseded or no longer needed]",
        },
      ];
    }
  }
}

/**
 * Inject sequential message IDs into eligible messages.
 * Updates state.messageIdSnapshot.
 */
function extractBlockOwnerKey(message: any): string | null {
  const content = message?.content
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part: any) => typeof part?.text === "string" ? part.text : "").join("\n")
      : ""
  const match = text.match(/<dcp-block-id>(b\d+)<\/dcp-block-id>/)
  return match?.[1] ? `block:${match[1]}` : null
}

function stripGeneratedDcpHallucinations(messages: any[]): void {
  for (const msg of messages) {
    const role = msg?.role
    if (role !== "assistant" && role !== "toolResult" && role !== "bashExecution") continue

    if (typeof msg.content === "string") {
      msg.content = stripDcpHallucinationsFromString(msg.content)
      continue
    }

    if (!Array.isArray(msg.content)) continue
    msg.content = msg.content.map((part: any) => {
      if (!part || typeof part !== "object") return part
      const clone = { ...part }
      if (typeof clone.text === "string") clone.text = stripDcpHallucinationsFromString(clone.text)
      if (typeof clone.input === "string") clone.input = stripDcpHallucinationsFromString(clone.input)
      return clone
    })
  }
}

function injectMessageIds(messages: any[], state: DcpState): void {
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

    const sourceKey = typeof msg[INTERNAL_SOURCE_KEY] === "string"
      ? msg[INTERNAL_SOURCE_KEY]
      : buildSourceItemKey(msg, ordinal);
    const id = allocateMessageRef(state.messageAliases, sourceKey);
    const ownerKey = extractBlockOwnerKey(msg)
      ?? (typeof msg[INTERNAL_OWNER_KEY] === "string" ? msg[INTERNAL_OWNER_KEY] : buildSourceOwnerKey(ordinal));
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
    } else if (role === "assistant") {
      if (Array.isArray(msg.content)) {
        // Insert the ID tag before any tool_use (toolCall) blocks.
        // Anthropic requires: thinking → text → tool_use.
        // Appending after tool_use blocks violates that constraint.
        const firstToolCallIdx = msg.content.findIndex(
          (b: any) => b.type === "toolCall",
        );
        const idBlock = { type: "text", text: metadataTag };
        if (firstToolCallIdx === -1) {
          // No tool_use blocks — append as usual
          msg.content = [...msg.content, idBlock];
        } else {
          // Insert immediately before the first tool_use block
          msg.content = [
            ...msg.content.slice(0, firstToolCallIdx),
            idBlock,
            ...msg.content.slice(firstToolCallIdx),
          ];
        }
      } else if (typeof msg.content === "string") {
        msg.content = msg.content + metadataTag;
      }
    }

    const timestamp = typeof msg.timestamp === "number" && Number.isFinite(msg.timestamp)
      ? msg.timestamp
      : null;
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

/**
 * Main transform: applies all pruning and returns modified message array.
 * Called from the `context` event handler.
 */
export function applyPruning(
  messages: DcpMessage[],
  state: DcpState,
  config: DcpConfig
): any[] {
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

  // 2b. Post-compression safety net: remove any orphaned tool pairs that the
  // expansion logic could not catch (e.g. multi-block interactions, pre-broken state).
  repairOrphanedToolPairs(msgs);

  // 3. Apply deduplication
  applyDeduplication(msgs, state, config);

  // 4. Apply error purging
  applyErrorPurging(msgs, state, config);

  // 5. Apply explicit tool output pruning (prunedToolIds)
  applyToolOutputPruning(msgs, state);

  // 6. Inject message IDs into visible messages
  injectMessageIds(msgs, state);

  // 7. state.messageIdSnapshot is already updated by injectMessageIds

  return msgs;
}

/**
 * Best-effort injection of a reminder into an existing visible message.
 * This avoids hijacking recency by appending a brand-new terminal user turn.
 */
function appendNudgeToMessage(message: any, nudgeText: string): boolean {
  if (!message) return false;

  if (typeof message.content === "string") {
    message.content = `${message.content}\n\n${nudgeText}`;
    return true;
  }

  if (!Array.isArray(message.content)) return false;

  const nudgeBlock = { type: "text", text: `\n${nudgeText}` };

  if (message.role === "assistant") {
    const firstToolCallIdx = message.content.findIndex((block: any) => block.type === "toolCall");
    if (firstToolCallIdx === -1) {
      message.content = [...message.content, nudgeBlock];
    } else {
      message.content = [
        ...message.content.slice(0, firstToolCallIdx),
        nudgeBlock,
        ...message.content.slice(firstToolCallIdx),
      ];
    }
    return true;
  }

  message.content = [...message.content, nudgeBlock];
  return true;
}

/**
 * Inject a nudge into the latest visible user/assistant message.
 * Falls back to a synthetic user message only if no suitable anchor exists.
 */
export function injectNudge(messages: DcpMessage[], nudgeText: string): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const role = message?.role ?? "";

    if (PASSTHROUGH_ROLES.has(role)) continue;
    if (role !== "user" && role !== "assistant") continue;

    if (appendNudgeToMessage(message, nudgeText)) {
      return;
    }
  }

  messages.push({
    role: "user",
    content: nudgeText,
    timestamp: Date.now(),
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
export function getNudgeType(
  contextPercent: number,
  state: DcpState,
  config: DcpConfig,
  toolCallsSinceLastUser: number
): "context-strong" | "context-soft" | "turn" | "iteration" | null {
  const {
    maxContextPercent,
    minContextPercent,
    nudgeDebounceTurns,
    nudgeForce,
    iterationNudgeThreshold,
  } = config.compress;
  const debounceTurns = Math.max(1, nudgeDebounceTurns);

  if (contextPercent < minContextPercent) {
    return null;
  }

  // A successful compress should buy immediate quiet. Do not nudge again in
  // the same logical turn that already produced a compress.
  if (state.currentTurn <= state.lastCompressTurn) {
    return null;
  }

  // Debounce by logical turns rather than by raw context passes.
  if (
    state.lastNudgeTurn >= 0 &&
    state.currentTurn - state.lastNudgeTurn < debounceTurns
  ) {
    return null;
  }

  if (contextPercent > maxContextPercent) {
    return nudgeForce === "strong" ? "context-strong" : "context-soft";
  }

  if (toolCallsSinceLastUser >= iterationNudgeThreshold) {
    return "iteration";
  }

  return "turn";
}
