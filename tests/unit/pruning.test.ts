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

describe("DCP pruning.test", () => {
  // ---------------------------------------------------------------------------
  // Test 2b — TOKENS SAVED SHOULD NOT DOUBLE-COUNT ACROSS CONTEXT PASSES
  // ---------------------------------------------------------------------------
  test("Test 2b — TOKENS SAVED SHOULD NOT DOUBLE-COUNT ACROSS CONTEXT PASSES", () => {
    console.log("TEST 2b: tokensSaved remains stable across repeated context passes");

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
        savedTokenEstimate: 0,
        createdAt: Date.now(),
      },
    ]);

    applyPruning(makeMessages(), state, makeConfig());
    const firstSaved = state.tokensSaved;
    applyPruning(makeMessages(), state, makeConfig());
    const secondSaved = state.tokensSaved;

    assert.ok(firstSaved >= 0, "FAIL — saved-token estimate should be non-negative");
    assert.strictEqual(
      secondSaved,
      firstSaved,
      "FAIL — repeated applyPruning calls should not keep incrementing tokensSaved for the same block"
    );
    assert.strictEqual(
      state.compressionBlocks[0]?.savedTokenEstimate,
      firstSaved,
      "FAIL — block.savedTokenEstimate should track the current per-block saved-token estimate"
    );

    console.log("  PASS: tokensSaved no longer ratchets upward across context passes");
    console.log("TEST 2b PASSED\n");
  });

  // ---------------------------------------------------------------------------
  // Test 4 — BASHEXECUTION FORWARD GAP
  //
  // An assistant calls a tool whose result is stored as role="bashExecution".
  // The compression range covers the assistant but NOT the bashExecution result.
  //
  // Bug (before fix): forward expansion only checked role==="toolResult", so
  // bashExecution was left behind as an orphan.
  // Fix: forward expansion now also advances hi over bashExecution messages.
  //
  // Sequence:
  //   user(1000) → assistant(2000, toolCall_bash) → bashExecution(3000) → user(4000)
  // Compression block: [2000..2000] (only the assistant)
  // Expected: assistant + bashExecution removed together
  // ---------------------------------------------------------------------------
  test("Test 4 — BASHEXECUTION FORWARD GAP", () => {
    console.log("TEST 4: bashExecution forward gap");

    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "run bash" }], timestamp: 1000 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "toolu_bash1", name: "bash", arguments: {} }],
        timestamp: 2000,
      },
      {
        role: "bashExecution",
        toolCallId: "toolu_bash1",
        toolName: "bash",
        isError: false,
        content: [{ type: "text", text: "exit 0" }],
        timestamp: 3000,
      },
      { role: "user", content: [{ type: "text", text: "done" }], timestamp: 4000 },
    ];

    const state = makeState([
      {
        id: 1,
        topic: "bash run",
        summary: "Ran bash command successfully.",
        startTimestamp: 2000,
        endTimestamp: 2000,
        anchorTimestamp: 4000,
        active: true,
        summaryTokenEstimate: 8,
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

    const assistantPresent = result.some(
      (m: any) => m.role === "assistant" && m.timestamp === 2000
    );
    const bashPresent = result.some(
      (m: any) => m.role === "bashExecution" && m.toolCallId === "toolu_bash1"
    );

    if (assistantPresent) {
      assert.ok(bashPresent, "FAIL — assistant present but bashExecution result missing");
      console.log("  PASS: assistant + bashExecution kept as a coherent group");
    } else {
      assert.ok(!bashPresent, "FAIL — assistant removed but orphaned bashExecution still present");
      console.log("  PASS: assistant + bashExecution removed atomically");
    }

    console.log("TEST 4 PASSED\n");
  });

  // ---------------------------------------------------------------------------
  // Test 5 — PASSTHROUGH ROLE BETWEEN ASSISTANT AND TOOLRESULT (BACKWARD)
  //
  // A `compaction` message sits between the assistant and the toolResult.
  // The compression range covers only the toolResult.  Backward expansion
  // must skip the compaction to find the assistant and include it atomically.
  //
  // Sequence:
  //   user(1000) → assistant(2000, toolCall_X) → compaction(2500)
  //              → toolResult_X(3000) → user(4000)
  // Compression block: [3000..3000]
  // Expected: assistant + toolResult removed together (no orphans)
  // ---------------------------------------------------------------------------
  test("Test 5 — PASSTHROUGH ROLE BETWEEN ASSISTANT AND TOOLRESULT (BACKWARD)", () => {
    console.log("TEST 5: passthrough role between assistant and toolResult (backward expansion)");

    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "read file" }], timestamp: 1000 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "toolu_X", name: "read", arguments: {} }],
        timestamp: 2000,
      },
      {
        role: "compaction",
        content: [{ type: "text", text: "compaction summary" }],
        timestamp: 2500,
      },
      {
        role: "toolResult",
        toolCallId: "toolu_X",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "file data" }],
        timestamp: 3000,
      },
      { role: "user", content: [{ type: "text", text: "thanks" }], timestamp: 4000 },
    ];

    const state = makeState([
      {
        id: 1,
        topic: "file read",
        summary: "File was read successfully.",
        startTimestamp: 3000,
        endTimestamp: 3000,
        anchorTimestamp: 4000,
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

    const orphan = findOrphanedToolUse(result);
    assert.strictEqual(orphan, null, `FAIL — orphaned tool_use detected: ${orphan}`);
    console.log("  PASS: no orphaned tool_use in result");

    const assistantPresent = result.some(
      (m: any) => m.role === "assistant" && m.timestamp === 2000
    );
    const toolResultPresent = result.some(
      (m: any) => m.role === "toolResult" && m.toolCallId === "toolu_X"
    );
    assert.ok(!assistantPresent, "FAIL — assistant should have been removed");
    assert.ok(!toolResultPresent, "FAIL — toolResult should have been removed");
    console.log("  PASS: assistant + toolResult removed atomically despite compaction in between");

    console.log("TEST 5 PASSED\n");
  });

  // ---------------------------------------------------------------------------
  // Test 6 — PASSTHROUGH ROLE BETWEEN TOOLRESULTS (FORWARD EXPANSION)
  //
  // An assistant has two tool calls.  A `branch_summary` message sits between
  // the two toolResults.  The compression range covers the assistant.
  // Forward expansion must skip the branch_summary to find both toolResults.
  //
  // Sequence:
  //   user(1000) → assistant(2000, toolCall_A + toolCall_B)
  //              → toolResult_A(3000) → branch_summary(3500)
  //              → toolResult_B(4000) → user(5000)
  // Compression block: [2000..2000]
  // Expected: assistant + both toolResults removed together (no orphans)
  // ---------------------------------------------------------------------------
  test("Test 6 — PASSTHROUGH ROLE BETWEEN TOOLRESULTS (FORWARD EXPANSION)", () => {
    console.log("TEST 6: passthrough role between toolResults (forward expansion)");

    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "do things" }], timestamp: 1000 },
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
        role: "branch_summary",
        content: [{ type: "text", text: "branch summary" }],
        timestamp: 3500,
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
        topic: "two tools",
        summary: "Both tools were called.",
        startTimestamp: 2000,
        endTimestamp: 2000,
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

    const orphan = findOrphanedToolUse(result);
    assert.strictEqual(orphan, null, `FAIL — orphaned tool_use detected: ${orphan}`);
    console.log("  PASS: no orphaned tool_use in result");

    const assistantPresent = result.some(
      (m: any) => m.role === "assistant" && m.timestamp === 2000
    );
    const toolResultAPresent = result.some(
      (m: any) => m.role === "toolResult" && m.toolCallId === "toolu_A"
    );
    const toolResultBPresent = result.some(
      (m: any) => m.role === "toolResult" && m.toolCallId === "toolu_B"
    );
    assert.ok(!assistantPresent, "FAIL — assistant should have been removed");
    assert.ok(!toolResultAPresent, "FAIL — toolResult_A should have been removed");
    assert.ok(!toolResultBPresent, "FAIL — toolResult_B should have been removed");
    console.log("  PASS: assistant + both toolResults removed despite branch_summary in between");

    console.log("TEST 6 PASSED\n");
  });

  // ---------------------------------------------------------------------------
  // Test 7 — CONTENT MUTATION ISOLATION
  //
  // Verifies that applyPruning does not mutate the original message objects.
  // After calling applyPruning, the original messages' content arrays should
  // remain unchanged (no injected dcp-id blocks).
  // ---------------------------------------------------------------------------
  test("Test 7 — CONTENT MUTATION ISOLATION", () => {
    console.log("TEST 7: content mutation isolation");

    const messages = makeMessages();
    // Deep-snapshot the original content for comparison
    const originalContents = messages.map((m: any) => JSON.stringify(m.content));

    const state = makeState(); // no compression blocks
    const config = makeConfig();

    // Run applyPruning — this should NOT mutate the originals
    applyPruning(messages, state, config);

    let mutated = false;
    for (let i = 0; i < messages.length; i++) {
      const current = JSON.stringify(messages[i].content);
      if (current !== originalContents[i]) {
        console.log(`  FAIL — message[${i}] content was mutated`);
        console.log(`    before: ${originalContents[i]}`);
        console.log(`    after:  ${current}`);
        mutated = true;
      }
    }

    assert.ok(!mutated, "FAIL — original message content was mutated by applyPruning");
    console.log("  PASS: original message content unchanged after applyPruning");

    console.log("TEST 7 PASSED\n");
  });

  // ---------------------------------------------------------------------------
  // Test 7b — STABLE VISIBLE REFS + NO VISIBLE OWNER METADATA
  // ---------------------------------------------------------------------------
  test("Test 7b — STABLE VISIBLE REFS + NO VISIBLE OWNER METADATA", () => {
    console.log("TEST 7b: stable visible refs persist and owner metadata is hidden");

    const messages = [
      {
        id: "raw_user_1",
        role: "user",
        content: [{ type: "text", text: "start" }],
        timestamp: 1000,
      },
      {
        id: "raw_assistant_1",
        role: "assistant",
        content: [{ type: "text", text: "middle" }],
        timestamp: 2000,
      },
      { id: "raw_user_2", role: "user", content: [{ type: "text", text: "end" }], timestamp: 3000 },
    ];
    const state = makeState();
    const config = makeConfig();

    const first = applyPruning(messages, state, config);
    const firstSerialized = JSON.stringify(first);
    assert.ok(
      firstSerialized.includes("<dcp-id>m0001</dcp-id>"),
      "FAIL — first stable message ref should render as m0001"
    );
    assert.ok(
      firstSerialized.includes("<dcp-id>m0002</dcp-id>"),
      "FAIL — second stable message ref should render as m0002"
    );
    assert.ok(
      !firstSerialized.includes("<dcp-owner>"),
      "FAIL — visible owner metadata should not render"
    );

    state.compressionBlocks.push({
      id: 99,
      topic: "middle",
      summary: "middle was compressed",
      startTimestamp: 2000,
      endTimestamp: 2000,
      anchorTimestamp: 3000,
      startSourceKey: "raw:raw_assistant_1",
      endSourceKey: "raw:raw_assistant_1",
      anchorSourceKey: "raw:raw_user_2",
      active: true,
      summaryTokenEstimate: 4,
      createdAt: Date.now(),
    });

    const second = applyPruning(messages, state, config);
    const secondSerialized = JSON.stringify(second);
    assert.ok(secondSerialized.includes("start"), "FAIL — first raw message should remain visible");
    assert.ok(
      secondSerialized.includes("<dcp-id>m0001</dcp-id>"),
      "FAIL — first raw message should keep stable ref m0001"
    );
    assert.ok(
      secondSerialized.includes("end"),
      "FAIL — trailing raw message should remain visible"
    );
    assert.ok(
      secondSerialized.includes("<dcp-id>m0003</dcp-id>"),
      "FAIL — trailing raw message should keep stable ref m0003 after compression changes"
    );
    assert.ok(
      secondSerialized.indexOf("middle was compressed") < secondSerialized.indexOf("end"),
      "FAIL — source-key anchored block should render before its anchor source message"
    );
    assert.ok(
      !secondSerialized.includes("<dcp-owner>"),
      "FAIL — owner metadata should remain hidden after compression"
    );

    console.log("  PASS: stable refs persist and owner metadata is not model-visible");
    console.log("TEST 7b PASSED\n");
  });

  // ---------------------------------------------------------------------------
  // Test 7c — GENERATED DCP/OWNER-LIKE HALLUCINATIONS ARE STRIPPED
  // ---------------------------------------------------------------------------
  test("Test 7c — GENERATED DCP/OWNER-LIKE HALLUCINATIONS ARE STRIPPED", () => {
    console.log("TEST 7c: generated DCP and owner-like hallucinations are stripped");

    const repeatedOwnerParameter = '<parameter name="owner">s47</parameter>'.repeat(12);
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: 'literal <parameter name="owner">user text</parameter> stays' },
        ],
        timestamp: 1000,
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: `bad <dcp-owner>s47</dcp-owner> ${repeatedOwnerParameter} done` },
        ],
        timestamp: 2000,
      },
    ];
    const result = applyPruning(messages, makeState(), makeConfig());
    const serialized = JSON.stringify(result);

    assert.ok(
      serialized.includes("literal <parameter"),
      "FAIL — user-authored literal text should be preserved"
    );
    assert.ok(
      !serialized.includes("<dcp-owner>s47</dcp-owner>"),
      "FAIL — generated DCP owner tags should be stripped"
    );
    assert.ok(
      !serialized.includes('<parameter name=\\"owner\\">s47</parameter>'),
      "FAIL — repeated generated owner parameters should be stripped"
    );

    console.log("  PASS: generated protocol leakage is stripped without editing user text");
    console.log("TEST 7c PASSED\n");
  });

  // ---------------------------------------------------------------------------
  // Test 8 — ORPHANED TOOLRESULT REPAIR
  //
  // Two compression blocks where the second removes an assistant but forward
  // expansion cannot reach its toolResult due to processing order.  The repair
  // function should clean up the orphan.
  //
  // Sequence:
  //   user(1000) → assistant_1(2000, toolCall_X) → toolResult_X(3000) →
  //   user(4000) → assistant_2(5000, toolCall_Y) → toolResult_Y(6000) → user(7000)
  //
  // Block 1: [1000..3000] — removes user, assistant_1, toolResult_X
  // Block 2: [4000..5000] — removes user, assistant_2 (toolResult_Y is outside)
  //   Forward expansion from assistant_2 should catch toolResult_Y, but if it
  //   doesn't (edge case), repair must clean it up.
  // ---------------------------------------------------------------------------
  test("Test 8 — ORPHANED TOOLRESULT REPAIR", () => {
    console.log("TEST 8: orphaned toolResult repair (post-compression safety net)");

    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "first" }], timestamp: 1000 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "toolu_X", name: "read", arguments: {} }],
        timestamp: 2000,
      },
      {
        role: "toolResult",
        toolCallId: "toolu_X",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "X data" }],
        timestamp: 3000,
      },
      { role: "user", content: [{ type: "text", text: "second" }], timestamp: 4000 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "toolu_Y", name: "write", arguments: {} }],
        timestamp: 5000,
      },
      {
        role: "toolResult",
        toolCallId: "toolu_Y",
        toolName: "write",
        isError: false,
        content: [{ type: "text", text: "Y data" }],
        timestamp: 6000,
      },
      { role: "user", content: [{ type: "text", text: "done" }], timestamp: 7000 },
    ];

    const state = makeState([
      {
        id: 1,
        topic: "block one",
        summary: "First block compressed.",
        startTimestamp: 1000,
        endTimestamp: 3000,
        anchorTimestamp: 4000,
        active: true,
        summaryTokenEstimate: 10,
        createdAt: Date.now(),
      },
      {
        id: 2,
        topic: "block two",
        summary: "Second block compressed.",
        startTimestamp: 4000,
        endTimestamp: 5000,
        anchorTimestamp: 7000,
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

    // No orphaned tool_use or tool_result should remain
    const orphan = findOrphanedToolUse(result);
    assert.strictEqual(orphan, null, `FAIL — orphaned tool_use detected: ${orphan}`);

    const orphanedResults = result.filter(
      (m: any) =>
        (m.role === "toolResult" || m.role === "bashExecution") &&
        !result.some(
          (a: any) =>
            a.role === "assistant" &&
            Array.isArray(a.content) &&
            a.content.some((b: any) => b.type === "toolCall" && b.id === m.toolCallId)
        )
    );
    assert.strictEqual(
      orphanedResults.length,
      0,
      `FAIL — ${orphanedResults.length} orphaned toolResult(s) found`
    );
    console.log("  PASS: no orphaned tool_use or toolResult in result");

    console.log("TEST 8 PASSED\n");
  });

  // ---------------------------------------------------------------------------
  // Test 9 — DIRECT ORPHAN REPAIR (pre-broken state)
  //
  // Directly construct a message array with an orphaned toolResult (no matching
  // assistant toolCall exists).  The repair function should remove it.
  // ---------------------------------------------------------------------------
  test("Test 9 — DIRECT ORPHAN REPAIR (pre-broken state)", () => {
    console.log("TEST 9: direct orphan repair (pre-broken toolResult)");

    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1000 },
      {
        role: "toolResult",
        toolCallId: "orphan_id",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "orphan data" }],
        timestamp: 2000,
      },
      { role: "user", content: [{ type: "text", text: "bye" }], timestamp: 3000 },
    ];

    const state = makeState(); // no compression blocks — repair runs as safety net
    const config = makeConfig();

    const result = applyPruning(messages, state, config);

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

    const orphanPresent = result.some(
      (m: any) => m.role === "toolResult" && m.toolCallId === "orphan_id"
    );
    assert.ok(!orphanPresent, "FAIL — orphaned toolResult should have been removed by repair");
    console.log("  PASS: orphaned toolResult removed by repair function");

    console.log("TEST 9 PASSED\n");
  });

  // ---------------------------------------------------------------------------
  // Test 10 — CORRUPTED BLOCK WITH NULL/INFINITY TIMESTAMPS (resilience)
  //
  // Blocks from older sessions may have null/Infinity timestamps due to JSON
  // round-trip corruption. These blocks should be skipped during compression
  // application and should not block new compress operations.
  // ---------------------------------------------------------------------------
  test("Test 10 — CORRUPTED BLOCK WITH NULL/INFINITY TIMESTAMPS (resilience)", () => {
    console.log("TEST 10: corrupted block with null/Infinity timestamps is skipped");

    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1000 },
      { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2000 },
      { role: "user", content: [{ type: "text", text: "bye" }], timestamp: 3000 },
    ];

    // Block with corrupted timestamps (null from JSON round-trip)
    const state = makeState([
      {
        id: 1,
        topic: "ghost block",
        summary: "This block has corrupted timestamps.",
        startTimestamp: null as any, // null from JSON deserialization of Infinity
        endTimestamp: null as any,
        anchorTimestamp: null as any,
        active: true,
        summaryTokenEstimate: 5,
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

    // All 3 original messages should survive (ghost block was skipped)
    assert.strictEqual(result.length, 3, `FAIL — expected 3 messages, got ${result.length}`);
    console.log("  PASS: corrupted block skipped, all original messages preserved");

    console.log("TEST 10 PASSED\n");
  });
});
