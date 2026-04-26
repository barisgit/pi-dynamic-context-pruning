// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) — compression range helpers
// ---------------------------------------------------------------------------

import type { DcpMessage } from "../../types/message.js"
export { estimateMessageTokens, estimateTokens } from "../tokens/estimate.js"

const PASSTHROUGH_ROLES = new Set(["compaction", "branch_summary", "custom_message"])

/**
 * Resolve the inclusive message index range covered by a timestamp-bounded
 * compression block, including the same assistant/tool-result expansion rules
 * used by the live pruning path.
 */
export function expandCompressionIndexRange(messages: any[], initialLo: number, initialHi: number): { lo: number; hi: number } {
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
