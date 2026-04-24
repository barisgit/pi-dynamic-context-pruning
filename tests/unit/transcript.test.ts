import { describe, expect, test } from "bun:test";
import {
  appendDebugLogLine,
  applyPruning,
  assert,
  buildBlockOwnerKey,
  buildCompressionArtifactsForRange,
  buildCompressionPlanningHints,
  buildLiveOwnerKeys,
  buildSessionDebugPayload,
  buildSourceOwnerKey,
  buildTranscriptSnapshot,
  extractCanonicalOwnerKeyFromMessageLike,
  filterProviderPayloadInput,
  findOrphanedToolUse,
  fs,
  getNudgeType,
  injectNudge,
  makeConfig,
  makeMessages,
  makeState,
  mapLegacyBlockToSpanRange,
  os,
  path,
  renderCompressedBlockMessage,
  renderCompressionPlanningHints,
  resolveAnchorSourceKey,
  resolveAnchorTimestamp,
  resolveProtectedTailStartTimestamp,
  resolveSupersededBlockIdsForRange,
  restorePersistedState,
  validateCompressionRangeBoundaryIds,
} from "../helpers/dcp-test-utils.js";

describe("DCP transcript.test", () => {
  // ---------------------------------------------------------------------------
  // Test 12 — LOGICAL TURN COUNTING GROUPS TOOL BATCHES INTO ONE TURN
  // ---------------------------------------------------------------------------
  test("Test 12 — LOGICAL TURN COUNTING GROUPS TOOL BATCHES INTO ONE TURN", () => {
    console.log("TEST 12: logical turn counting treats one tool batch as one turn");

    const state = makeState();
    const result = applyPruning(makeMessages(), state, makeConfig());

    assert.strictEqual(
      result.length,
      4,
      "FAIL — baseline pruning should preserve the four raw messages"
    );
    assert.strictEqual(
      state.currentTurn,
      3,
      "FAIL — expected user + tool batch + user to count as 3 logical turns"
    );

    console.log("  PASS: logical turn counting matches message/tool-batch semantics");
    console.log("TEST 12 PASSED\n");
  });

  // ---------------------------------------------------------------------------
  // Test 14 — TRANSCRIPT SNAPSHOT GROUPS TOOL EXCHANGES
  // ---------------------------------------------------------------------------
  test("Test 14 — TRANSCRIPT SNAPSHOT GROUPS TOOL EXCHANGES", () => {
    console.log("TEST 14: transcript snapshot groups tool exchanges");

    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "run two tools" }], timestamp: 1000 },
      {
        role: "assistant",
        content: [
          { type: "text", text: "working" },
          { type: "toolCall", id: "toolu_A", name: "read", arguments: {} },
          { type: "toolCall", id: "toolu_B", name: "bash", arguments: {} },
        ],
        timestamp: 2000,
      },
      {
        role: "toolResult",
        toolCallId: "toolu_A",
        toolName: "read",
        content: [{ type: "text", text: "file contents" }],
        isError: false,
        timestamp: 3000,
      },
      {
        role: "branch_summary",
        content: [{ type: "text", text: "internal passthrough" }],
        timestamp: 3500,
      },
      {
        role: "bashExecution",
        toolCallId: "toolu_B",
        toolName: "bash",
        content: [{ type: "text", text: "exit 0" }],
        isError: false,
        timestamp: 4000,
      },
      { role: "user", content: [{ type: "text", text: "thanks" }], timestamp: 5000 },
    ];

    const snapshot = buildTranscriptSnapshot(messages);

    assert.strictEqual(
      snapshot.sourceItems.length,
      6,
      "FAIL — sourceItems should include every raw message"
    );
    assert.strictEqual(
      snapshot.spans.length,
      3,
      "FAIL — expected user / tool-exchange / user spans"
    );

    const exchange = snapshot.spans[1]!;
    assert.strictEqual(
      exchange.kind,
      "tool-exchange",
      "FAIL — middle span should be a tool-exchange"
    );
    assert.strictEqual(
      exchange.role,
      "assistant",
      "FAIL — tool-exchange span role should be assistant"
    );
    assert.strictEqual(
      exchange.messageCount,
      4,
      "FAIL — tool-exchange should include assistant + results + passthrough"
    );
    assert.strictEqual(
      exchange.startSourceKey,
      snapshot.sourceItems[1]!.key,
      "FAIL — tool-exchange should start at the assistant"
    );
    assert.strictEqual(
      exchange.endSourceKey,
      snapshot.sourceItems[4]!.key,
      "FAIL — tool-exchange should end at the final linked result"
    );
    assert.deepStrictEqual(
      exchange.sourceKeys,
      snapshot.sourceItems.slice(1, 5).map((item) => item.key),
      "FAIL — tool-exchange should cover the assistant, linked results, and passthrough entries"
    );

    console.log("  PASS: transcript snapshot builds coherent tool-exchange spans");
    console.log("TEST 14 PASSED\n");
  });

  // ---------------------------------------------------------------------------
  // Test 14b — LEGACY BLOCKS MAP TO ENCOMPASSING TOOL-EXCHANGE SPANS
  // ---------------------------------------------------------------------------
  test("Test 14b — LEGACY BLOCKS MAP TO ENCOMPASSING TOOL-EXCHANGE SPANS", () => {
    console.log("TEST 14b: legacy block remap targets enclosing tool-exchange span");

    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "run two tools" }], timestamp: 1000 },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "toolu_A", name: "read", arguments: {} },
          { type: "toolCall", id: "toolu_B", name: "bash", arguments: {} },
        ],
        timestamp: 2000,
      },
      {
        role: "toolResult",
        toolCallId: "toolu_A",
        toolName: "read",
        content: [{ type: "text", text: "file contents" }],
        isError: false,
        timestamp: 3000,
      },
      {
        role: "bashExecution",
        toolCallId: "toolu_B",
        toolName: "bash",
        content: [{ type: "text", text: "exit 0" }],
        isError: false,
        timestamp: 4000,
      },
      { role: "user", content: [{ type: "text", text: "thanks" }], timestamp: 5000 },
    ];

    const snapshot = buildTranscriptSnapshot(messages);
    const toolExchange = snapshot.spans[1]!;

    const mapped = mapLegacyBlockToSpanRange(
      {
        id: 1,
        topic: "single tool result",
        summary: "Tool result compressed.",
        startTimestamp: 3000,
        endTimestamp: 3000,
        anchorTimestamp: 3001,
        active: true,
        summaryTokenEstimate: 10,
        createdAt: 1,
      },
      snapshot
    );

    assert.ok(mapped, "FAIL — legacy block should map onto snapshot spans");
    assert.strictEqual(
      mapped!.startSpanKey,
      toolExchange.key,
      "FAIL — start timestamp inside tool exchange should map to the exchange span"
    );
    assert.strictEqual(
      mapped!.endSpanKey,
      toolExchange.key,
      "FAIL — end timestamp inside tool exchange should map to the exchange span"
    );

    console.log("  PASS: legacy timestamp blocks remap to enclosing tool-exchange spans");
    console.log("TEST 14b PASSED\n");
  });

  // ---------------------------------------------------------------------------
  // Test 16 — LEGACY V2 STATE RESTORES INTO NEW METADATA SHAPE
  // ---------------------------------------------------------------------------
  test("Test 16 — LEGACY V2 STATE RESTORES INTO NEW METADATA SHAPE", () => {
    console.log("TEST 16: legacy v2 state restores into new metadata shape");

    const state = makeState();
    restorePersistedState(
      {
        schemaVersion: 2,
        nextBlockId: 3,
        manualMode: false,
        blocks: [
          {
            id: 2,
            topic: "old v2 block",
            summary: "Older scaffold block without explicit metadata.",
            startSpanKey: "span:1",
            endSpanKey: "span:3",
            supersedesBlockIds: [1],
            status: "active",
            summaryTokenEstimate: 42,
            createdAt: 123,
          },
        ],
      },
      state
    );

    assert.strictEqual(
      state.schemaVersion,
      2,
      "FAIL — restore should switch runtime state to schema v2"
    );
    assert.strictEqual(
      state.compressionBlocksV2.length,
      1,
      "FAIL — expected one restored v2 block"
    );

    const block = state.compressionBlocksV2[0]!;
    assert.deepStrictEqual(
      block.metadata.supersededBlockIds,
      [1],
      "FAIL — legacy superseded block ids should migrate into hidden metadata"
    );
    assert.deepStrictEqual(
      block.activityLog,
      [],
      "FAIL — missing activity log should normalize to an empty array"
    );
    assert.deepStrictEqual(
      block.metadata.coveredSourceKeys,
      [],
      "FAIL — missing coveredSourceKeys should normalize to an empty array"
    );
    assert.deepStrictEqual(
      block.metadata.coveredSpanKeys,
      [],
      "FAIL — missing coveredSpanKeys should normalize to an empty array"
    );
    assert.deepStrictEqual(
      block.metadata.commandStats,
      [],
      "FAIL — missing commandStats should normalize to an empty array"
    );

    console.log("  PASS: legacy v2 scaffold state restores into the new metadata-rich shape");
    console.log("TEST 16 PASSED\n");
  });
});
