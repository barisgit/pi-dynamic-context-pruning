import type { DcpConfig } from "../../src/types/config.js";
import type { DcpState } from "../../src/types/state.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  allocateMessageRef,
  createMessageAliasState,
  formatMessageRef,
  normalizeMessageAliasState,
  parseVisibleRef,
} from "../../src/domain/refs/index.js";

export { default as assert } from "node:assert";
export { fs, os, path };
export {
  buildCompressionArtifactsForRange,
  buildCompressionPlanningHints,
  registerCompressTool,
  renderCompressionPlanningHints,
  resolveAnchorSourceKey,
  resolveAnchorTimestamp,
  resolveProtectedTailStartTimestamp,
  resolveSupersededBlockIdsForRange,
  validateCompressionRangeBoundaryIds,
} from "../../src/application/compress-tool/index.js";
export {
  appendDebugLogLine,
  buildSessionDebugPayload,
} from "../../src/infrastructure/debug-log.js";
export { registerContextHandler } from "../../src/application/context-handler.js";
export {
  restorePersistedState,
  mapLegacyBlockToSpanRange,
} from "../../src/infrastructure/persistence.js";
export { renderCompressedBlockMessage } from "../../src/domain/compression/materialize.js";
export {
  allocateMessageRef,
  createMessageAliasState,
  formatMessageRef,
  normalizeMessageAliasState,
  parseVisibleRef,
};
export {
  extractCanonicalOwnerKeyFromMessageLike,
  filterProviderPayloadInput,
} from "../../src/domain/provider/payload-filter.js";
export {
  applyPruning,
  exceedsMaxContextLimit,
  getNudgeType,
} from "../../src/domain/pruning/index.js";
export {
  buildBlockOwnerKey,
  buildLiveOwnerKeys,
  buildSourceOwnerKey,
  buildTranscriptSnapshot,
} from "../../src/domain/transcript/index.js";

// ---------------------------------------------------------------------------
// Minimal factories
// ---------------------------------------------------------------------------

export function makeConfig(): DcpConfig {
  return {
    enabled: true,
    debug: false,
    manualMode: { enabled: false, automaticStrategies: false },
    compress: {
      maxContextPercent: 0.8,
      minContextPercent: 0.4,
      nudgeDebounceTurns: 2,
      nudgeFrequency: 5,
      iterationNudgeThreshold: 15,
      protectRecentTurns: 4,
      renderFullBlockCount: 2,
      renderCompactBlockCount: 3,
      nudgeForce: "soft",
      protectedTools: [],
      protectUserMessages: false,
    },
    strategies: {
      deduplication: { enabled: false, protectedTools: [] },
      purgeErrors: { enabled: false, turns: 4, protectedTools: [] },
    },
    protectedFilePatterns: [],
    pruneNotification: "off",
  };
}

export function makeState(compressionBlocks: DcpState["compressionBlocks"] = []): DcpState {
  return {
    toolCalls: new Map(),
    prunedToolIds: new Set(),
    schemaVersion: 1,
    compressionBlocks,
    compressionBlocksV2: [],
    nextBlockId: 1,
    lastRenderedMessages: [],
    lastLiveOwnerKeys: [],
    messageAliases: createMessageAliasState(),
    messageRefSnapshot: new Map(),
    messageIdSnapshot: new Map(),
    messageOwnerSnapshot: new Map(),
    currentTurn: 0,
    tokensSaved: 0,
    totalPruneCount: 0,
    manualMode: false,
    lastNudgeTurn: -1,
    lastCompressTurn: -1,
  };
}

// Four-message sequence that exercises the bug:
//   user(1000) → assistant+toolCall(2000) → toolResult(3000) → user(4000)
export function makeMessages(): any[] {
  return [
    {
      role: "user",
      content: [{ type: "text", text: "please read the file" }],
      timestamp: 1000,
    },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "toolu_abc", name: "read", arguments: {} }],
      timestamp: 2000,
    },
    {
      role: "toolResult",
      toolCallId: "toolu_abc",
      toolName: "read",
      content: [{ type: "text", text: "file content" }],
      isError: false,
      timestamp: 3000,
    },
    {
      role: "user",
      content: [{ type: "text", text: "thanks" }],
      timestamp: 4000,
    },
  ];
}

// ---------------------------------------------------------------------------
// Helper: find the first orphaned tool_use in a result array
//
// An assistant message is "orphaned" if it contains a toolCall block whose
// id does NOT have a matching toolResult as the very next message.
// ---------------------------------------------------------------------------
export function findOrphanedToolUse(result: any[]): string | null {
  for (let i = 0; i < result.length; i++) {
    const msg = result[i];
    if (msg.role !== "assistant") continue;

    const content: any[] = Array.isArray(msg.content) ? msg.content : [];
    const toolCallBlocks = content.filter((b: any) => b.type === "toolCall");
    if (toolCallBlocks.length === 0) continue;

    for (const tc of toolCallBlocks) {
      const next = result[i + 1];
      const nextIsMatchingResult = next && next.role === "toolResult" && next.toolCallId === tc.id;

      if (!nextIsMatchingResult) {
        return (
          `assistant at index ${i} (ts=${msg.timestamp}) has toolCall id="${tc.id}" ` +
          `but next message is: ${next ? `role="${next.role}" toolCallId="${next.toolCallId}"` : "<nothing>"}`
        );
      }
    }
  }
  return null; // no orphan found
}
