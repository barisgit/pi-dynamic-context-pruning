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

describe("DCP apply pruning.test", () => {
  // ---------------------------------------------------------------------------
  // Test 1 — BUG SCENARIO
  //
  // Compression block covers ONLY the toolResult (startTimestamp=3000,
  // endTimestamp=3000).  Without the backward-expansion fix, the assistant
  // message with the toolCall block survives but its toolResult is gone →
  // orphaned tool_use.  With the fix the assistant is pulled into the range
  // and both messages are removed together.
  // ---------------------------------------------------------------------------
  test("Test 1 — BUG SCENARIO", () => {
    console.log("TEST 1: compression block covers only the toolResult (bug scenario)");

    const messages = makeMessages();
    const state = makeState([
      {
        id: 1,
        topic: "file read",
        summary: "The file was read and contained some data.",
        startTimestamp: 3000,
        endTimestamp: 3000,
        anchorTimestamp: 4000,
        active: true,
        summaryTokenEstimate: 15,
        createdAt: Date.now(),
      },
    ]);
    const config = makeConfig();

    const result = applyPruning(messages, state, config);

    console.log("  Result messages (role, timestamp):");
    for (const m of result) {
      const ts = m.timestamp;
      const preview =
        typeof m.content === "string"
          ? m.content.slice(0, 60)
          : Array.isArray(m.content)
            ? m.content
                .map((b: any) => b.text ?? b.type ?? "?")
                .join(" | ")
                .slice(0, 60)
            : "?";
      console.log(`    role="${m.role}"  ts=${ts}  content="${preview}"`);
    }

    // 1a. No orphaned tool_use
    const orphan = findOrphanedToolUse(result);
    assert.strictEqual(orphan, null, `FAIL — orphaned tool_use detected: ${orphan}`);
    console.log("  PASS: no orphaned tool_use in result");

    // 1b. The assistant message at ts=2000 must NOT survive without its partner
    const assistantInResult = result.find((m) => m.role === "assistant" && m.timestamp === 2000);
    if (assistantInResult) {
      // If it survived, its immediate successor must be the matching toolResult
      const idx = result.indexOf(assistantInResult);
      const successor = result[idx + 1];
      assert.ok(
        successor && successor.role === "toolResult" && successor.toolCallId === "toolu_abc",
        `FAIL — assistant(ts=2000) survived but successor is not the matching toolResult ` +
          `(got role="${successor?.role}" toolCallId="${successor?.toolCallId}")`
      );
      console.log("  PASS: assistant survived with its toolResult partner intact");
    } else {
      // The preferred outcome: both removed together
      const toolResultInResult = result.find(
        (m) => m.role === "toolResult" && m.toolCallId === "toolu_abc"
      );
      assert.strictEqual(
        toolResultInResult,
        undefined,
        "FAIL — assistant removed but orphaned toolResult still present"
      );
      console.log("  PASS: both assistant and toolResult removed together");
    }

    console.log("TEST 1 PASSED\n");
  });

  // ---------------------------------------------------------------------------
  // Test 2 — PASSING SCENARIO
  //
  // Compression block covers BOTH the assistant and the toolResult
  // (startTimestamp=2000, endTimestamp=3000).  Both messages must be removed
  // and no orphaned tool_use must remain.
  // ---------------------------------------------------------------------------
  test("Test 2 — PASSING SCENARIO", () => {
    console.log(
      "TEST 2: compression block covers both assistant and toolResult (passing scenario)"
    );

    const messages = makeMessages();
    const state = makeState([
      {
        id: 1,
        topic: "file read",
        summary: "The file was read and contained some data.",
        startTimestamp: 2000,
        endTimestamp: 3000,
        anchorTimestamp: 4000,
        active: true,
        summaryTokenEstimate: 15,
        createdAt: Date.now(),
      },
    ]);
    const config = makeConfig();

    const result = applyPruning(messages, state, config);

    console.log("  Result messages (role, timestamp):");
    for (const m of result) {
      const ts = m.timestamp;
      const preview =
        typeof m.content === "string"
          ? m.content.slice(0, 60)
          : Array.isArray(m.content)
            ? m.content
                .map((b: any) => b.text ?? b.type ?? "?")
                .join(" | ")
                .slice(0, 60)
            : "?";
      console.log(`    role="${m.role}"  ts=${ts}  content="${preview}"`);
    }

    // 2a. No orphaned tool_use
    const orphan = findOrphanedToolUse(result);
    assert.strictEqual(orphan, null, `FAIL — orphaned tool_use detected: ${orphan}`);
    console.log("  PASS: no orphaned tool_use in result");

    // 2b. The assistant at ts=2000 must be absent from the result
    const assistantInResult = result.find((m) => m.role === "assistant" && m.timestamp === 2000);
    assert.strictEqual(
      assistantInResult,
      undefined,
      `FAIL — assistant(ts=2000) should have been removed but is still present`
    );
    console.log("  PASS: assistant(ts=2000) removed");

    // 2c. The toolResult must also be absent
    const toolResultInResult = result.find(
      (m) => m.role === "toolResult" && m.toolCallId === "toolu_abc"
    );
    assert.strictEqual(
      toolResultInResult,
      undefined,
      `FAIL — toolResult(toolCallId="toolu_abc") should have been removed but is still present`
    );
    console.log("  PASS: toolResult(toolu_abc) removed");

    // 2d. A synthetic summary message should be present
    const synthetic = result.find(
      (m) =>
        m.role === "user" &&
        typeof m.content?.[0]?.text === "string" &&
        m.content[0].text.includes("Compressed section")
    );
    assert.ok(synthetic, "FAIL — expected a synthetic [Compressed section] user message in result");
    console.log("  PASS: synthetic summary message present");

    console.log("TEST 2 PASSED\n");
  });

  // ---------------------------------------------------------------------------
  // Test 3 — MULTI-TOOLRESULT BACKWARD GAP
  //
  // assistant has TWO tool_calls (A + B) producing two consecutive toolResult
  // messages.  The compression range starts at toolResult_B — meaning there is
  // a toolResult message (A) sitting between lo and the assistant.
  //
  // Bug: backward expansion stopped at toolResult_A (not an assistant) and
  // never found the assistant → assistant was kept without its toolResult_B.
  // Fix: backward scan skips past toolResult messages to reach the assistant.
  //
  // Sequence:
  //   user(1000) → assistant(2000, toolCall_A + toolCall_B)
  //              → toolResult_A(3000) → toolResult_B(4000) → user(5000)
  // Compression block: [4000..4000] (only toolResult_B)
  // Expected: assistant + toolResult_A + toolResult_B all removed together
  // ---------------------------------------------------------------------------
  test("Test 3 — MULTI-TOOLRESULT BACKWARD GAP", () => {
    console.log("TEST 3: multi-toolResult backward gap (assistant has 2 tool_calls)");

    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "do two things" }], timestamp: 1000 },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "toolu_A", name: "read", arguments: {} },
          { type: "toolCall", id: "toolu_B", name: "write", arguments: {} },
        ],
        timestamp: 2000,
      },
      {
        role: "toolResult",
        toolCallId: "toolu_A",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "A result" }],
        timestamp: 3000,
      },
      {
        role: "toolResult",
        toolCallId: "toolu_B",
        toolName: "write",
        isError: false,
        content: [{ type: "text", text: "B result" }],
        timestamp: 4000,
      },
      { role: "user", content: [{ type: "text", text: "thanks" }], timestamp: 5000 },
    ];

    const state = makeState([
      {
        id: 1,
        topic: "two-tool work",
        summary: "Both tools were called successfully.",
        startTimestamp: 4000, // only toolResult_B
        endTimestamp: 4000,
        anchorTimestamp: 5000,
        active: true,
        summaryTokenEstimate: 10,
        createdAt: Date.now(),
      },
    ]);

    const result = applyPruning(messages, state, makeConfig());

    console.log("  Result messages:");
    for (const m of result) {
      const preview = Array.isArray(m.content)
        ? m.content
            .map((b: any) => b.text ?? b.type ?? "?")
            .join(" | ")
            .slice(0, 60)
        : String(m.content).slice(0, 60);
      console.log(`    role="${m.role}"  ts=${m.timestamp}  content="${preview}"`);
    }

    // Neither the orphaned assistant nor its toolResults should survive unpaired
    const assistantPresent = result.some(
      (m: any) => m.role === "assistant" && m.timestamp === 2000
    );
    const toolResultAPresent = result.some(
      (m: any) => m.role === "toolResult" && m.toolCallId === "toolu_A"
    );
    const toolResultBPresent = result.some(
      (m: any) => m.role === "toolResult" && m.toolCallId === "toolu_B"
    );

    // All three must be absent (removed atomically) or all three present as a valid group
    if (assistantPresent) {
      assert.ok(toolResultAPresent, "FAIL — assistant present but toolResult_A missing");
      assert.ok(toolResultBPresent, "FAIL — assistant present but toolResult_B missing");
      // Verify ordering: assistant → toolResult_A → toolResult_B
      const aIdx = result.findIndex((m: any) => m.role === "assistant" && m.timestamp === 2000);
      const rAIdx = result.findIndex(
        (m: any) => m.role === "toolResult" && m.toolCallId === "toolu_A"
      );
      const rBIdx = result.findIndex(
        (m: any) => m.role === "toolResult" && m.toolCallId === "toolu_B"
      );
      assert.ok(aIdx < rAIdx && rAIdx < rBIdx, "FAIL — assistant + toolResult ordering wrong");
      console.log("  PASS: assistant + both toolResults kept as a coherent group");
    } else {
      assert.ok(
        !toolResultAPresent,
        "FAIL — assistant removed but orphaned toolResult_A still present"
      );
      assert.ok(
        !toolResultBPresent,
        "FAIL — assistant removed but orphaned toolResult_B still present"
      );
      console.log("  PASS: assistant + both toolResults removed atomically");
    }

    console.log("TEST 3 PASSED\n");
  });

  // ---------------------------------------------------------------------------
  // Test 3b — SOURCE-KEY RANGE STILL EXPANDS TOOL EXCHANGES
  // ---------------------------------------------------------------------------
  test("Test 3b — SOURCE-KEY RANGE STILL EXPANDS TOOL EXCHANGES", () => {
    console.log("TEST 3b: source-key anchored range removes tool exchange atomically");

    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "do two things" }], timestamp: 1000 },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "toolu_A", name: "read", arguments: {} },
          { type: "toolCall", id: "toolu_B", name: "write", arguments: {} },
        ],
        timestamp: 2000,
      },
      {
        role: "toolResult",
        toolCallId: "toolu_A",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "A result" }],
        timestamp: 3000,
      },
      {
        role: "toolResult",
        toolCallId: "toolu_B",
        toolName: "write",
        isError: false,
        content: [{ type: "text", text: "B result" }],
        timestamp: 4000,
      },
      { role: "user", content: [{ type: "text", text: "thanks" }], timestamp: 5000 },
    ];

    const state = makeState([
      {
        id: 1,
        topic: "source-key tool work",
        summary: "Both tools were called successfully.",
        startTimestamp: 4000,
        endTimestamp: 4000,
        anchorTimestamp: 5000,
        startSourceKey: "msg:4000:toolResult:toolu_B:3",
        endSourceKey: "msg:4000:toolResult:toolu_B:3",
        anchorSourceKey: "msg:5000:user:4",
        active: true,
        summaryTokenEstimate: 10,
        createdAt: Date.now(),
      },
    ]);

    const result = applyPruning(messages, state, makeConfig());
    const assistantPresent = result.some(
      (m: any) => m.role === "assistant" && m.timestamp === 2000
    );
    const toolResultAPresent = result.some(
      (m: any) => m.role === "toolResult" && m.toolCallId === "toolu_A"
    );
    const toolResultBPresent = result.some(
      (m: any) => m.role === "toolResult" && m.toolCallId === "toolu_B"
    );

    assert.ok(!assistantPresent, "FAIL — source-key range left assistant tool calls behind");
    assert.ok(!toolResultAPresent, "FAIL — source-key range left sibling toolResult behind");
    assert.ok(!toolResultBPresent, "FAIL — source-key range left selected toolResult behind");
    assert.ok(
      result.some(
        (m: any) =>
          typeof m.content?.[0]?.text === "string" &&
          m.content[0].text.includes("Both tools were called successfully.")
      ),
      "FAIL — compressed summary should be rendered"
    );

    console.log("  PASS: source-key ranges reuse tool-exchange expansion");
    console.log("TEST 3b PASSED\n");
  });
});
