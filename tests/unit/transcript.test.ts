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
  makeConfig,
  makeMessages,
  makeState,
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
});
