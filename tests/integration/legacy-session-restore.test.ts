// ---------------------------------------------------------------------------
// Integration tests for replay-first restore with snapshot fallback (f3).
// ---------------------------------------------------------------------------
//
// These tests drive `restoreStateFromBranch` directly against synthetic
// branch entries that mimic what `ctx.sessionManager.getBranch()` returns
// at runtime. They cover:
//
//   1. Pure dcp-state snapshot (no transcript)            -> snapshot-fallback
//   2. Transcript with a successful compress tool result  -> replay
//   3. Branch with native-compaction entry + snapshot but
//      no compress transcript                              -> snapshot-fallback
//   4. Branch with compress events but the assistant
//      tool-call message is missing (malformed)           -> snapshot-fallback
//      (no crash; replay tolerates and engine returns
//       empty blocks; snapshot fallback fires because a
//       dcp-state entry is also present.)

import { describe, expect, test } from "bun:test";
import { restoreStateFromBranch } from "../../src/application/session-handler.js";
import { serializePersistedState } from "../../src/infrastructure/persistence.js";
import type { CompressionBlock } from "../../src/types/state.js";
import { makeConfig, makeState } from "../helpers/dcp-test-utils.js";

function block(id: number, active: boolean): CompressionBlock {
  return {
    id,
    topic: "legacy block",
    summary: "legacy summary text",
    startTimestamp: 1000,
    endTimestamp: 1500,
    anchorTimestamp: 1600,
    active,
    summaryTokenEstimate: 10,
    savedTokenEstimate: active ? 250 : 0,
    createdAt: 1500,
  };
}

function dcpStateEntry(data: unknown): any {
  return {
    type: "custom",
    customType: "dcp-state",
    data,
    id: "snap-1",
    parentId: null,
    timestamp: new Date().toISOString(),
  };
}

function messageEntry(message: any): any {
  return {
    type: "message",
    message,
    id: `msg-${message.timestamp}`,
    parentId: null,
    timestamp: new Date(message.timestamp).toISOString(),
  };
}

function nativeCompactionEntry(representedBlockIds: number[]): any {
  return {
    type: "compaction",
    summary: "native compaction",
    id: "comp-1",
    parentId: null,
    timestamp: new Date().toISOString(),
    details: {
      source: "dcp-native-compaction",
      version: 1,
      representedBlockIds,
      requestedBlockIds: representedBlockIds,
    },
  };
}

describe("Legacy session restore (f3)", () => {
  test("pure dcp-state snapshot -> snapshot-fallback mode", () => {
    const persisted = makeState([block(1, true)]);
    persisted.nextBlockId = 2;
    persisted.tokensSaved = 250;

    const branch = [dcpStateEntry(serializePersistedState(persisted))];
    const state = makeState();
    const result = restoreStateFromBranch(branch, state, makeConfig());

    expect(result.mode).toBe("snapshot-fallback");
    expect(result.restoredStateEntries).toBe(1);
    expect(state.compressionBlocks).toHaveLength(1);
    expect(state.compressionBlocks[0]?.active).toBe(true);
    expect(state.tokensSaved).toBe(250);
  });

  test("transcript with a successful compress -> replay mode", () => {
    const LONG =
      "This is a verbose user/assistant message body that exists purely so that " +
      "token estimation yields a meaningfully large number for both source items. ".repeat(20);
    const branch = [
      messageEntry({
        role: "user",
        content: [{ type: "text", text: LONG + " alpha" }],
        timestamp: 1000,
      }),
      messageEntry({
        role: "assistant",
        content: [{ type: "text", text: LONG + " beta" }],
        timestamp: 2000,
      }),
      messageEntry({
        role: "user",
        content: [{ type: "text", text: "compress now" }],
        timestamp: 3000,
      }),
      messageEntry({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-c1",
            name: "compress",
            arguments: {
              ranges: [
                {
                  startId: "m0001",
                  endId: "m0002",
                  summary: "intro pair",
                  topic: "intro pair",
                },
              ],
            },
          },
        ],
        timestamp: 4000,
      }),
      messageEntry({
        role: "toolResult",
        toolCallId: "call-c1",
        toolName: "compress",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 5000,
      }),
    ];
    const state = makeState();
    const result = restoreStateFromBranch(branch, state, makeConfig());

    expect(result.mode).toBe("replay");
    expect(state.compressionBlocks).toHaveLength(1);
    expect(state.compressionBlocks[0]?.active).toBe(true);
    expect(state.compressionBlocks[0]?.topic).toBe("intro pair");
    expect(state.tokensSaved).toBeGreaterThan(0);
  });

  test("compaction entry + snapshot + no compress transcript -> snapshot-fallback", () => {
    // Pre-v3 session that compacted under the old runtime: a compaction
    // entry sits on the branch but the original compress tool-call frames
    // are gone (pi rewrote agent.state.messages). The snapshot is the only
    // truth.
    const persisted = makeState([block(1, false)]);
    persisted.nextBlockId = 2;
    persisted.lifetimeTokensSavedRealized = 999;

    const branch = [
      nativeCompactionEntry([1]),
      dcpStateEntry(serializePersistedState(persisted)),
    ];
    const state = makeState();
    const result = restoreStateFromBranch(branch, state, makeConfig());

    expect(result.mode).toBe("snapshot-fallback");
    expect(state.compressionBlocks).toHaveLength(1);
    expect(state.compressionBlocks[0]?.active).toBe(false);
    expect(state.lifetimeTokensSavedRealized).toBe(999);
  });

  test("fallback: malformed compress tool result with no matching assistant call survives", () => {
    // The assistant call frame is missing; the toolResult dangles. The
    // engine must not throw, and since a dcp-state snapshot is present we
    // fall back to it.
    const persisted = makeState([block(7, true)]);
    persisted.nextBlockId = 8;
    persisted.tokensSaved = 250;

    const branch = [
      dcpStateEntry(serializePersistedState(persisted)),
      messageEntry({
        role: "toolResult",
        toolCallId: "call-orphan",
        toolName: "compress",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 5000,
      }),
    ];
    const state = makeState();
    const result = restoreStateFromBranch(branch, state, makeConfig());

    // Replay sees the compress success, tries to find the matching call,
    // gets null, skips. Then state.compressionBlocks is empty AND a
    // snapshot exists, so we take the fallback.
    expect(result.mode).toBe("snapshot-fallback");
    expect(state.compressionBlocks).toHaveLength(1);
    expect(state.compressionBlocks[0]?.id).toBe(7);
    expect(state.compressionBlocks[0]?.active).toBe(true);
  });
});
