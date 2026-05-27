import { describe, expect, test } from "bun:test";
import { replayDcpState } from "../../src/domain/replay/index.js";
import { makeConfig } from "../helpers/dcp-test-utils.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeBranch(messages: any[]): { type: "message"; message: any }[] {
  return messages.map((message) => ({ type: "message", message }));
}

function makeUser(text: string, timestamp: number): any {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  };
}

function makeAssistantText(text: string, timestamp: number): any {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp,
  };
}

function makeAssistantToolCall(
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
  timestamp: number
): any {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: args }],
    timestamp,
  };
}

function makeToolResult(
  toolCallId: string,
  toolName: string,
  text: string,
  timestamp: number,
  isError = false
): any {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError,
    timestamp,
  };
}

function makeCompactionEntry(
  representedBlockIds: number[],
  timestamp: string,
  summary: string = "compaction summary"
): any {
  return {
    type: "compaction",
    summary,
    timestamp,
    details: {
      source: "dcp-native-compaction",
      version: 1,
      requestId: "req-1",
      reason: "auto",
      representedBlockIds,
      requestedBlockIds: representedBlockIds,
      firstKeptEntryId: "entry-x",
      hiddenMessageCount: 0,
      uncoveredHiddenMessageCount: 0,
      renderedUncoveredExcerptCount: 0,
      truncatedUncoveredExcerptCount: 0,
      readFiles: [],
      modifiedFiles: [],
    },
  };
}

describe("DCP replay engine", () => {
  // A long body of text to make estimated removed-tokens dominate the
  // rendered block message tokens so saved estimate is positive.
  const LONG_BODY =
    "This is a verbose message body that exists purely so that token estimation " +
    "yields a meaningfully large number. ".repeat(20);

  // -------------------------------------------------------------------------
  // Test R1 — Single successful compress reconstructs a CompressionBlock
  // -------------------------------------------------------------------------
  test("R1 — single compress produces one active block with non-zero savings", () => {
    // Build a transcript with three messages, then a compress targeting the
    // visible non-assistant boundaries around the assistant reply. The replay
    // engine must allocate message refs for those eligible entries and
    // reconstruct the block.
    const m1 = makeUser(LONG_BODY + " alpha", 1000);
    const m2 = makeAssistantText(LONG_BODY + " beta", 2000);
    const m3 = makeUser("Now compress the first two messages.", 3000);

    const compressArgs = {
      ranges: [
        {
          startId: "m0001",
          endId: "m0002",
          summary: "intro exchange",
          topic: "intro exchange",
        },
      ],
    };
    const assistantCompress = makeAssistantToolCall(
      "call-compress-1",
      "compress",
      compressArgs,
      4000
    );
    const compressResult = makeToolResult(
      "call-compress-1",
      "compress",
      "Compressed 1 range(s)",
      5000
    );

    const branch = makeBranch([m1, m2, m3, assistantCompress, compressResult]);
    const config = makeConfig();
    const state = replayDcpState(branch, config);

    expect(state.compressionBlocks.length).toBe(1);
    const block = state.compressionBlocks[0]!;
    expect(block.id).toBe(1);
    expect(block.topic).toBe("intro exchange");
    expect(block.active).toBe(true);
    expect(block.compressCallId).toBe("call-compress-1");
    expect(block.summary).toContain("intro exchange");
    expect(block.metadata?.coveredSourceKeys.length).toBe(3);
    expect(block.savedTokenEstimate ?? 0).toBeGreaterThan(0);
    expect(state.tokensSaved).toBe(block.savedTokenEstimate ?? 0);
    expect(state.nextBlockId).toBe(2);
    // tool_call & tool_result for `compress` were recorded
    const compressRecord = state.toolCalls.get("call-compress-1");
    expect(compressRecord).toBeDefined();
    expect(compressRecord?.toolName).toBe("compress");
    expect(compressRecord?.isError).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test R2 — Two compresses with the second fully covering the first
  //           → supersession deactivates the earlier block
  // -------------------------------------------------------------------------
  test("R2 — second compress fully containing first supersedes the older block", () => {
    const m1 = makeUser(LONG_BODY + " alpha", 1000);
    const m2 = makeUser(LONG_BODY + " beta", 2000);
    const m3 = makeUser(LONG_BODY + " gamma", 3000);
    const m4 = makeUser(LONG_BODY + " delta", 4000);

    // First compress: range m0001..m0002.
    const compress1 = makeAssistantToolCall(
      "call-c1",
      "compress",
      {
        ranges: [
          {
            startId: "m0001",
            endId: "m0002",
            summary: "first half summary",
            topic: "first half",
          },
        ],
      },
      5000
    );
    const compress1Result = makeToolResult("call-c1", "compress", "ok", 6000);

    // Second compress: after compress1 the visible transcript is
    // [b1, m3, m4, ...] and the messageAliases registry keeps m3→m0003,
    // m4→m0004 (m0001/m0002 were assigned to the now-hidden m1/m2 and the
    // allocator does not reuse freed refs). To fully supersede block 1 we
    // reference it explicitly via `b1` as the start and m0004 as the end.
    const compress2 = makeAssistantToolCall(
      "call-c2",
      "compress",
      {
        ranges: [
          {
            startId: "b1",
            endId: "m0004",
            summary: "wider summary covering all four",
            topic: "wider span",
          },
        ],
      },
      7000
    );
    const compress2Result = makeToolResult("call-c2", "compress", "ok", 8000);

    const branch = makeBranch([
      m1,
      m2,
      m3,
      m4,
      compress1,
      compress1Result,
      compress2,
      compress2Result,
    ]);
    const state = replayDcpState(branch, makeConfig());

    expect(state.compressionBlocks.length).toBe(2);
    const block1 = state.compressionBlocks[0]!;
    const block2 = state.compressionBlocks[1]!;
    expect(block1.id).toBe(1);
    expect(block1.active).toBe(false); // superseded
    expect(block2.id).toBe(2);
    expect(block2.active).toBe(true);
    expect(block2.metadata?.supersededBlockIds).toContain(1);

    // tokensSaved should only count the active block
    expect(state.tokensSaved).toBe(block2.savedTokenEstimate ?? 0);
    expect(state.nextBlockId).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Test R3 — DCP native-compaction entry deactivates represented blocks
  //           and bakes savings into lifetimeTokensSavedRealized
  // -------------------------------------------------------------------------
  test("R3 — native compaction entry deactivates represented blocks and bakes savings", () => {
    const m1 = makeUser(LONG_BODY + " alpha", 1000);
    const m2 = makeUser(LONG_BODY + " beta", 2000);

    const compress1 = makeAssistantToolCall(
      "call-c1",
      "compress",
      {
        ranges: [
          {
            startId: "m0001",
            endId: "m0002",
            summary: "summary of first two",
            topic: "first pair",
          },
        ],
      },
      3000
    );
    const compress1Result = makeToolResult("call-c1", "compress", "ok", 4000);

    // Native compaction representing block id=1
    const compactionEntry = makeCompactionEntry([1], "2024-01-01T00:00:00.000Z");

    const branch = [
      ...makeBranch([m1, m2, compress1, compress1Result]),
      compactionEntry,
    ];
    const state = replayDcpState(branch, makeConfig());

    expect(state.compressionBlocks.length).toBe(1);
    const block = state.compressionBlocks[0]!;
    expect(block.active).toBe(false);
    expect(block.savedTokenEstimate ?? 0).toBeGreaterThan(0);
    expect(state.tokensSaved).toBe(0);
    expect(state.lifetimeTokensSavedRealized).toBe(block.savedTokenEstimate ?? 0);
    // Watermarks reset by native-compaction folding
    expect(state.lastCompressTurn).toBe(-1);
    expect(state.lastNudgeTurn).toBe(-1);
  });

  // -------------------------------------------------------------------------
  // Test R4 — Dedup + error-purge interaction
  //           Replay populates state.toolCalls so applyPruning's strategies
  //           can tombstone duplicates / errored results into prunedToolIds.
  // -------------------------------------------------------------------------
  test("R4 — dedup strategy tombstones older duplicate tool results during replay", () => {
    const args = { command: "echo hello" };
    const u1 = makeUser("please run echo", 1000);
    const a1 = makeAssistantToolCall("call-b1", "bash", args, 2000);
    const r1 = makeToolResult("call-b1", "bash", "hello", 3000);
    const u2 = makeUser("again", 4000);
    const a2 = makeAssistantToolCall("call-b2", "bash", args, 5000);
    const r2 = makeToolResult("call-b2", "bash", "hello", 6000);

    const branch = makeBranch([u1, a1, r1, u2, a2, r2]);
    const config = makeConfig();
    // Enable deduplication so identical fingerprints get tombstoned
    config.strategies.deduplication.enabled = true;

    const state = replayDcpState(branch, config);

    // The older duplicate should be marked pruned; the newer one is kept.
    expect(state.prunedToolIds.has("call-b1")).toBe(true);
    expect(state.prunedToolIds.has("call-b2")).toBe(false);

    // toolCalls must be populated for both ids with the same fingerprint
    const r1Record = state.toolCalls.get("call-b1");
    const r2Record = state.toolCalls.get("call-b2");
    expect(r1Record?.inputFingerprint).toBe(r2Record?.inputFingerprint);
    expect(r1Record?.toolName).toBe("bash");
  });
});
