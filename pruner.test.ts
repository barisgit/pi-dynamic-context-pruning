/**
 * Minimal self-contained tests for the applyCompressionBlocks logic inside
 * applyPruning.  No test framework — just assert + console.log.
 *
 * Run with:  bun run pruner.test.ts
 */

import assert from "assert";
import {
  buildCompressionArtifactsForRange,
  resolveProtectedTailStartTimestamp,
} from "./compress-tool.js";
import { restorePersistedState, mapLegacyBlockToSpanRange } from "./migration.js";
import { renderCompressedBlockMessage } from "./materialize.js";
import { filterProviderPayloadInput } from "./payload-filter.js";
import { applyPruning, getNudgeType, injectNudge } from "./pruner.js";
import { buildTranscriptSnapshot } from "./transcript.js";
import type { DcpState } from "./state.js";
import type { DcpConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Minimal factories
// ---------------------------------------------------------------------------

function makeConfig(): DcpConfig {
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

function makeState(compressionBlocks: DcpState["compressionBlocks"] = []): DcpState {
  return {
    toolCalls: new Map(),
    prunedToolIds: new Set(),
    schemaVersion: 1,
    compressionBlocks,
    compressionBlocksV2: [],
    nextBlockId: 1,
    lastRenderedMessages: [],
    messageIdSnapshot: new Map(),
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
function makeMessages(): any[] {
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
function findOrphanedToolUse(result: any[]): string | null {
  for (let i = 0; i < result.length; i++) {
    const msg = result[i];
    if (msg.role !== "assistant") continue;

    const content: any[] = Array.isArray(msg.content) ? msg.content : [];
    const toolCallBlocks = content.filter((b: any) => b.type === "toolCall");
    if (toolCallBlocks.length === 0) continue;

    for (const tc of toolCallBlocks) {
      const next = result[i + 1];
      const nextIsMatchingResult =
        next &&
        next.role === "toolResult" &&
        next.toolCallId === tc.id;

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

// ---------------------------------------------------------------------------
// Test 1 — BUG SCENARIO
//
// Compression block covers ONLY the toolResult (startTimestamp=3000,
// endTimestamp=3000).  Without the backward-expansion fix, the assistant
// message with the toolCall block survives but its toolResult is gone →
// orphaned tool_use.  With the fix the assistant is pulled into the range
// and both messages are removed together.
// ---------------------------------------------------------------------------
{
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
        ? m.content.map((b: any) => b.text ?? b.type ?? "?").join(" | ").slice(0, 60)
        : "?";
    console.log(`    role="${m.role}"  ts=${ts}  content="${preview}"`);
  }

  // 1a. No orphaned tool_use
  const orphan = findOrphanedToolUse(result);
  assert.strictEqual(
    orphan,
    null,
    `FAIL — orphaned tool_use detected: ${orphan}`
  );
  console.log("  PASS: no orphaned tool_use in result");

  // 1b. The assistant message at ts=2000 must NOT survive without its partner
  const assistantInResult = result.find(
    (m) => m.role === "assistant" && m.timestamp === 2000
  );
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
}

// ---------------------------------------------------------------------------
// Test 2 — PASSING SCENARIO
//
// Compression block covers BOTH the assistant and the toolResult
// (startTimestamp=2000, endTimestamp=3000).  Both messages must be removed
// and no orphaned tool_use must remain.
// ---------------------------------------------------------------------------
{
  console.log("TEST 2: compression block covers both assistant and toolResult (passing scenario)");

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
        ? m.content.map((b: any) => b.text ?? b.type ?? "?").join(" | ").slice(0, 60)
        : "?";
    console.log(`    role="${m.role}"  ts=${ts}  content="${preview}"`);
  }

  // 2a. No orphaned tool_use
  const orphan = findOrphanedToolUse(result);
  assert.strictEqual(
    orphan,
    null,
    `FAIL — orphaned tool_use detected: ${orphan}`
  );
  console.log("  PASS: no orphaned tool_use in result");

  // 2b. The assistant at ts=2000 must be absent from the result
  const assistantInResult = result.find(
    (m) => m.role === "assistant" && m.timestamp === 2000
  );
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
    (m) => m.role === "user" && typeof m.content?.[0]?.text === "string" && m.content[0].text.includes("Compressed section")
  );
  assert.ok(
    synthetic,
    "FAIL — expected a synthetic [Compressed section] user message in result"
  );
  console.log("  PASS: synthetic summary message present");

  console.log("TEST 2 PASSED\n");
}

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
{
  console.log("TEST 3: multi-toolResult backward gap (assistant has 2 tool_calls)");

  const messages: any[] = [
    { role: "user",        content: [{ type: "text", text: "do two things" }], timestamp: 1000 },
    { role: "assistant",   content: [
        { type: "toolCall", id: "toolu_A", name: "read",  arguments: {} },
        { type: "toolCall", id: "toolu_B", name: "write", arguments: {} },
      ], timestamp: 2000 },
    { role: "toolResult",  toolCallId: "toolu_A", toolName: "read",  isError: false, content: [{ type: "text", text: "A result" }], timestamp: 3000 },
    { role: "toolResult",  toolCallId: "toolu_B", toolName: "write", isError: false, content: [{ type: "text", text: "B result" }], timestamp: 4000 },
    { role: "user",        content: [{ type: "text", text: "thanks" }], timestamp: 5000 },
  ];

  const state = makeState([
    {
      id: 1,
      topic: "two-tool work",
      summary: "Both tools were called successfully.",
      startTimestamp: 4000,  // only toolResult_B
      endTimestamp:   4000,
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
      ? m.content.map((b: any) => b.text ?? b.type ?? "?").join(" | ").slice(0, 60)
      : String(m.content).slice(0, 60);
    console.log(`    role="${m.role}"  ts=${m.timestamp}  content="${preview}"`);
  }

  // Neither the orphaned assistant nor its toolResults should survive unpaired
  const assistantPresent = result.some((m: any) => m.role === "assistant" && m.timestamp === 2000);
  const toolResultAPresent = result.some((m: any) => m.role === "toolResult" && m.toolCallId === "toolu_A");
  const toolResultBPresent = result.some((m: any) => m.role === "toolResult" && m.toolCallId === "toolu_B");

  // All three must be absent (removed atomically) or all three present as a valid group
  if (assistantPresent) {
    assert.ok(toolResultAPresent, "FAIL — assistant present but toolResult_A missing");
    assert.ok(toolResultBPresent, "FAIL — assistant present but toolResult_B missing");
    // Verify ordering: assistant → toolResult_A → toolResult_B
    const aIdx = result.findIndex((m: any) => m.role === "assistant" && m.timestamp === 2000);
    const rAIdx = result.findIndex((m: any) => m.role === "toolResult" && m.toolCallId === "toolu_A");
    const rBIdx = result.findIndex((m: any) => m.role === "toolResult" && m.toolCallId === "toolu_B");
    assert.ok(aIdx < rAIdx && rAIdx < rBIdx, "FAIL — assistant + toolResult ordering wrong");
    console.log("  PASS: assistant + both toolResults kept as a coherent group");
  } else {
    assert.ok(!toolResultAPresent, "FAIL — assistant removed but orphaned toolResult_A still present");
    assert.ok(!toolResultBPresent, "FAIL — assistant removed but orphaned toolResult_B still present");
    console.log("  PASS: assistant + both toolResults removed atomically");
  }

  console.log("TEST 3 PASSED\n");
}

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
{
  console.log("TEST 4: bashExecution forward gap");

  const messages: any[] = [
    { role: "user",          content: [{ type: "text", text: "run bash" }], timestamp: 1000 },
    { role: "assistant",     content: [{ type: "toolCall", id: "toolu_bash1", name: "bash", arguments: {} }], timestamp: 2000 },
    { role: "bashExecution", toolCallId: "toolu_bash1", toolName: "bash", isError: false, content: [{ type: "text", text: "exit 0" }], timestamp: 3000 },
    { role: "user",          content: [{ type: "text", text: "done" }], timestamp: 4000 },
  ];

  const state = makeState([
    {
      id: 1,
      topic: "bash run",
      summary: "Ran bash command successfully.",
      startTimestamp: 2000,
      endTimestamp:   2000,
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
      ? m.content.map((b: any) => b.text ?? b.type ?? "?").join(" | ").slice(0, 60)
      : String(m.content).slice(0, 60);
    console.log(`    role="${m.role}"  ts=${m.timestamp}  content="${preview}"`);
  }

  const assistantPresent   = result.some((m: any) => m.role === "assistant"     && m.timestamp === 2000);
  const bashPresent        = result.some((m: any) => m.role === "bashExecution" && m.toolCallId === "toolu_bash1");

  if (assistantPresent) {
    assert.ok(bashPresent, "FAIL — assistant present but bashExecution result missing");
    console.log("  PASS: assistant + bashExecution kept as a coherent group");
  } else {
    assert.ok(!bashPresent, "FAIL — assistant removed but orphaned bashExecution still present");
    console.log("  PASS: assistant + bashExecution removed atomically");
  }

  console.log("TEST 4 PASSED\n");
}

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
{
  console.log("TEST 5: passthrough role between assistant and toolResult (backward expansion)");

  const messages: any[] = [
    { role: "user",        content: [{ type: "text", text: "read file" }], timestamp: 1000 },
    { role: "assistant",   content: [{ type: "toolCall", id: "toolu_X", name: "read", arguments: {} }], timestamp: 2000 },
    { role: "compaction",  content: [{ type: "text", text: "compaction summary" }], timestamp: 2500 },
    { role: "toolResult",  toolCallId: "toolu_X", toolName: "read", isError: false, content: [{ type: "text", text: "file data" }], timestamp: 3000 },
    { role: "user",        content: [{ type: "text", text: "thanks" }], timestamp: 4000 },
  ];

  const state = makeState([
    {
      id: 1,
      topic: "file read",
      summary: "File was read successfully.",
      startTimestamp: 3000,
      endTimestamp:   3000,
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
      ? m.content.map((b: any) => b.text ?? b.type ?? "?").join(" | ").slice(0, 60)
      : String(m.content).slice(0, 60);
    console.log(`    role="${m.role}"  ts=${m.timestamp}  content="${preview}"`);
  }

  const orphan = findOrphanedToolUse(result);
  assert.strictEqual(orphan, null, `FAIL — orphaned tool_use detected: ${orphan}`);
  console.log("  PASS: no orphaned tool_use in result");

  const assistantPresent = result.some((m: any) => m.role === "assistant" && m.timestamp === 2000);
  const toolResultPresent = result.some((m: any) => m.role === "toolResult" && m.toolCallId === "toolu_X");
  assert.ok(!assistantPresent, "FAIL — assistant should have been removed");
  assert.ok(!toolResultPresent, "FAIL — toolResult should have been removed");
  console.log("  PASS: assistant + toolResult removed atomically despite compaction in between");

  console.log("TEST 5 PASSED\n");
}

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
{
  console.log("TEST 6: passthrough role between toolResults (forward expansion)");

  const messages: any[] = [
    { role: "user",           content: [{ type: "text", text: "do things" }], timestamp: 1000 },
    { role: "assistant",      content: [
        { type: "toolCall", id: "toolu_A", name: "read",  arguments: {} },
        { type: "toolCall", id: "toolu_B", name: "write", arguments: {} },
      ], timestamp: 2000 },
    { role: "toolResult",     toolCallId: "toolu_A", toolName: "read",  isError: false, content: [{ type: "text", text: "A result" }], timestamp: 3000 },
    { role: "branch_summary", content: [{ type: "text", text: "branch summary" }], timestamp: 3500 },
    { role: "toolResult",     toolCallId: "toolu_B", toolName: "write", isError: false, content: [{ type: "text", text: "B result" }], timestamp: 4000 },
    { role: "user",           content: [{ type: "text", text: "thanks" }], timestamp: 5000 },
  ];

  const state = makeState([
    {
      id: 1,
      topic: "two tools",
      summary: "Both tools were called.",
      startTimestamp: 2000,
      endTimestamp:   2000,
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
      ? m.content.map((b: any) => b.text ?? b.type ?? "?").join(" | ").slice(0, 60)
      : String(m.content).slice(0, 60);
    console.log(`    role="${m.role}"  ts=${m.timestamp}  content="${preview}"`);
  }

  const orphan = findOrphanedToolUse(result);
  assert.strictEqual(orphan, null, `FAIL — orphaned tool_use detected: ${orphan}`);
  console.log("  PASS: no orphaned tool_use in result");

  const assistantPresent = result.some((m: any) => m.role === "assistant" && m.timestamp === 2000);
  const toolResultAPresent = result.some((m: any) => m.role === "toolResult" && m.toolCallId === "toolu_A");
  const toolResultBPresent = result.some((m: any) => m.role === "toolResult" && m.toolCallId === "toolu_B");
  assert.ok(!assistantPresent, "FAIL — assistant should have been removed");
  assert.ok(!toolResultAPresent, "FAIL — toolResult_A should have been removed");
  assert.ok(!toolResultBPresent, "FAIL — toolResult_B should have been removed");
  console.log("  PASS: assistant + both toolResults removed despite branch_summary in between");

  console.log("TEST 6 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 7 — CONTENT MUTATION ISOLATION
//
// Verifies that applyPruning does not mutate the original message objects.
// After calling applyPruning, the original messages' content arrays should
// remain unchanged (no injected dcp-id blocks).
// ---------------------------------------------------------------------------
{
  console.log("TEST 7: content mutation isolation");

  const messages = makeMessages();
  // Deep-snapshot the original content for comparison
  const originalContents = messages.map((m: any) =>
    JSON.stringify(m.content)
  );

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
}

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
{
  console.log("TEST 8: orphaned toolResult repair (post-compression safety net)");

  const messages: any[] = [
    { role: "user",       content: [{ type: "text", text: "first" }], timestamp: 1000 },
    { role: "assistant",  content: [{ type: "toolCall", id: "toolu_X", name: "read", arguments: {} }], timestamp: 2000 },
    { role: "toolResult", toolCallId: "toolu_X", toolName: "read", isError: false, content: [{ type: "text", text: "X data" }], timestamp: 3000 },
    { role: "user",       content: [{ type: "text", text: "second" }], timestamp: 4000 },
    { role: "assistant",  content: [{ type: "toolCall", id: "toolu_Y", name: "write", arguments: {} }], timestamp: 5000 },
    { role: "toolResult", toolCallId: "toolu_Y", toolName: "write", isError: false, content: [{ type: "text", text: "Y data" }], timestamp: 6000 },
    { role: "user",       content: [{ type: "text", text: "done" }], timestamp: 7000 },
  ];

  const state = makeState([
    {
      id: 1,
      topic: "block one",
      summary: "First block compressed.",
      startTimestamp: 1000,
      endTimestamp:   3000,
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
      endTimestamp:   5000,
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
      ? m.content.map((b: any) => b.text ?? b.type ?? "?").join(" | ").slice(0, 60)
      : String(m.content).slice(0, 60);
    console.log(`    role="${m.role}"  ts=${m.timestamp}  content="${preview}"`);
  }

  // No orphaned tool_use or tool_result should remain
  const orphan = findOrphanedToolUse(result);
  assert.strictEqual(orphan, null, `FAIL — orphaned tool_use detected: ${orphan}`);

  const orphanedResults = result.filter(
    (m: any) => (m.role === "toolResult" || m.role === "bashExecution") &&
    !result.some((a: any) =>
      a.role === "assistant" &&
      Array.isArray(a.content) &&
      a.content.some((b: any) => b.type === "toolCall" && b.id === m.toolCallId)
    )
  );
  assert.strictEqual(orphanedResults.length, 0, `FAIL — ${orphanedResults.length} orphaned toolResult(s) found`);
  console.log("  PASS: no orphaned tool_use or toolResult in result");

  console.log("TEST 8 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 9 — DIRECT ORPHAN REPAIR (pre-broken state)
//
// Directly construct a message array with an orphaned toolResult (no matching
// assistant toolCall exists).  The repair function should remove it.
// ---------------------------------------------------------------------------
{
  console.log("TEST 9: direct orphan repair (pre-broken toolResult)");

  const messages: any[] = [
    { role: "user",       content: [{ type: "text", text: "hello" }], timestamp: 1000 },
    { role: "toolResult", toolCallId: "orphan_id", toolName: "read", isError: false, content: [{ type: "text", text: "orphan data" }], timestamp: 2000 },
    { role: "user",       content: [{ type: "text", text: "bye" }], timestamp: 3000 },
  ];

  const state = makeState(); // no compression blocks — repair runs as safety net
  const config = makeConfig();

  const result = applyPruning(messages, state, config);

  console.log("  Result messages:");
  for (const m of result) {
    const preview = Array.isArray(m.content)
      ? m.content.map((b: any) => b.text ?? b.type ?? "?").join(" | ").slice(0, 60)
      : String(m.content).slice(0, 60);
    console.log(`    role="${m.role}"  ts=${m.timestamp}  content="${preview}"`);
  }

  const orphanPresent = result.some((m: any) => m.role === "toolResult" && m.toolCallId === "orphan_id");
  assert.ok(!orphanPresent, "FAIL — orphaned toolResult should have been removed by repair");
  console.log("  PASS: orphaned toolResult removed by repair function");

  console.log("TEST 9 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 10 — CORRUPTED BLOCK WITH NULL/INFINITY TIMESTAMPS (resilience)
//
// Blocks from older sessions may have null/Infinity timestamps due to JSON
// round-trip corruption. These blocks should be skipped during compression
// application and should not block new compress operations.
// ---------------------------------------------------------------------------
{
  console.log("TEST 10: corrupted block with null/Infinity timestamps is skipped");

  const messages: any[] = [
    { role: "user",       content: [{ type: "text", text: "hello" }], timestamp: 1000 },
    { role: "assistant",  content: [{ type: "text", text: "hi" }], timestamp: 2000 },
    { role: "user",       content: [{ type: "text", text: "bye" }], timestamp: 3000 },
  ];

  // Block with corrupted timestamps (null from JSON round-trip)
  const state = makeState([
    {
      id: 1,
      topic: "ghost block",
      summary: "This block has corrupted timestamps.",
      startTimestamp: null as any,  // null from JSON deserialization of Infinity
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
      ? m.content.map((b: any) => b.text ?? b.type ?? "?").join(" | ").slice(0, 60)
      : String(m.content).slice(0, 60);
    console.log(`    role="${m.role}"  ts=${m.timestamp}  content="${preview}"`);
  }

  // All 3 original messages should survive (ghost block was skipped)
  assert.strictEqual(result.length, 3, `FAIL — expected 3 messages, got ${result.length}`);
  console.log("  PASS: corrupted block skipped, all original messages preserved");

  console.log("TEST 10 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 11 — NUDGE INJECTION SHOULD ANCHOR TO EXISTING MESSAGE
//
// Reminders should not be appended as a fresh terminal user message because
// that hijacks recency and focus. They should attach to the latest visible
// user/assistant message when possible.
// ---------------------------------------------------------------------------
{
  console.log("TEST 11: nudge injection anchors to existing message");

  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "do the thing" }], timestamp: 1000 },
    { role: "assistant", content: [{ type: "text", text: "working" }], timestamp: 2000 },
  ];

  injectNudge(messages, "<dcp-system-reminder>compress maybe</dcp-system-reminder>");

  assert.strictEqual(messages.length, 2, "FAIL — injectNudge should not append a new message when an anchor exists");
  assert.strictEqual(messages[1]?.role, "assistant", "FAIL — last message role should stay assistant");

  const content = messages[1]?.content;
  const joined = Array.isArray(content)
    ? content.map((part: any) => part?.text ?? "").join("\n")
    : String(content ?? "");

  assert.ok(joined.includes("<dcp-system-reminder>compress maybe</dcp-system-reminder>"), "FAIL — anchored nudge text missing from assistant message");
  console.log("  PASS: reminder attached to existing assistant message");

  console.log("TEST 11 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 12 — TURN NUDGES SHOULD RESPECT TURN DEBOUNCE AND COMPRESS COOL-DOWN
// ---------------------------------------------------------------------------
{
  console.log("TEST 12: turn nudge debounce + post-compress suppression");

  const config = makeConfig();
  config.compress.minContextPercent = 0.75;
  config.compress.maxContextPercent = 0.9;
  config.compress.nudgeDebounceTurns = 2;

  const state = makeState();
  state.currentTurn = 5;
  state.lastNudgeTurn = 5;

  assert.strictEqual(
    getNudgeType(0.8, state, config, 0),
    null,
    "FAIL — should not emit a turn nudge twice in the same user turn",
  );

  state.currentTurn = 6;
  state.lastNudgeTurn = 5;
  assert.strictEqual(
    getNudgeType(0.8, state, config, 0),
    null,
    "FAIL — should debounce for one newer user turn when debounceTurns=2",
  );

  state.currentTurn = 7;
  state.lastNudgeTurn = 5;
  assert.strictEqual(
    getNudgeType(0.8, state, config, 0),
    "turn",
    "FAIL — should emit once enough newer user turns have happened",
  );

  state.currentTurn = 7;
  state.lastCompressTurn = 7;
  state.lastNudgeTurn = 7;
  assert.strictEqual(
    getNudgeType(0.95, state, config, 0),
    null,
    "FAIL — should not emit in the same user turn that already compressed",
  );

  state.currentTurn = 8;
  assert.strictEqual(
    getNudgeType(0.95, state, config, 0),
    null,
    "FAIL — should stay quiet on the first newer user turn after compress when debounceTurns=2",
  );

  state.currentTurn = 9;
  assert.strictEqual(
    getNudgeType(0.95, state, config, 0),
    "context-soft",
    "FAIL — should re-emit once compress cool-down and debounce are both satisfied",
  );

  console.log("  PASS: turn debounce and post-compress suppression work");
  console.log("TEST 12 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 13 — TRANSCRIPT SNAPSHOT GROUPS TOOL EXCHANGES
// ---------------------------------------------------------------------------
{
  console.log("TEST 13: transcript snapshot groups tool exchanges");

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

  assert.strictEqual(snapshot.sourceItems.length, 6, "FAIL — sourceItems should include every raw message");
  assert.strictEqual(snapshot.spans.length, 3, "FAIL — expected user / tool-exchange / user spans");

  const exchange = snapshot.spans[1]!;
  assert.strictEqual(exchange.kind, "tool-exchange", "FAIL — middle span should be a tool-exchange");
  assert.strictEqual(exchange.role, "assistant", "FAIL — tool-exchange span role should be assistant");
  assert.strictEqual(exchange.messageCount, 4, "FAIL — tool-exchange should include assistant + results + passthrough");
  assert.strictEqual(exchange.startSourceKey, snapshot.sourceItems[1]!.key, "FAIL — tool-exchange should start at the assistant");
  assert.strictEqual(exchange.endSourceKey, snapshot.sourceItems[4]!.key, "FAIL — tool-exchange should end at the final linked result");
  assert.deepStrictEqual(
    exchange.sourceKeys,
    snapshot.sourceItems.slice(1, 5).map((item) => item.key),
    "FAIL — tool-exchange should cover the assistant, linked results, and passthrough entries",
  );

  console.log("  PASS: transcript snapshot builds coherent tool-exchange spans");
  console.log("TEST 13 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 14 — LEGACY BLOCKS MAP TO ENCOMPASSING TOOL-EXCHANGE SPANS
// ---------------------------------------------------------------------------
{
  console.log("TEST 14: legacy block remap targets enclosing tool-exchange span");

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
    snapshot,
  );

  assert.ok(mapped, "FAIL — legacy block should map onto snapshot spans");
  assert.strictEqual(mapped!.startSpanKey, toolExchange.key, "FAIL — start timestamp inside tool exchange should map to the exchange span");
  assert.strictEqual(mapped!.endSpanKey, toolExchange.key, "FAIL — end timestamp inside tool exchange should map to the exchange span");

  console.log("  PASS: legacy timestamp blocks remap to enclosing tool-exchange spans");
  console.log("TEST 14 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 15 — V2 BLOCK RENDERER EMITS A FACTUAL CHRONOLOGICAL LOG
// ---------------------------------------------------------------------------
{
  console.log("TEST 15: v2 block renderer emits summary + chronological log");

  const message = renderCompressedBlockMessage({
    id: 7,
    topic: "dogfood block format",
    summary: "Renderer work started for the new deterministic block shape.",
    activityLogVersion: 1,
    activityLog: [
      { kind: "user_excerpt", text: '"You need to remember one thing: SIMPLE..."' },
      { kind: "assistant_excerpt", text: '"Default answer: keep `compress` simple..."' },
      { kind: "command", text: "bun run pruner.test.ts -> ok" },
      { kind: "commit", text: 'ff104f4 "Refine DCP v2 block design"' },
    ],
  });

  const text = message.content?.[0]?.text ?? "";
  assert.ok(text.includes("[Compressed section: dogfood block format]"), "FAIL — missing compressed section header");
  assert.ok(text.includes("<agent-summary>"), "FAIL — expected structured summary wrapper when activity log exists");
  assert.ok(text.includes("<dcp-log v=\"1\">"), "FAIL — expected deterministic log wrapper");
  assert.ok(text.includes('u: "You need to remember one thing: SIMPLE..."'), "FAIL — expected raw user excerpt log line");
  assert.ok(text.includes('a: "Default answer: keep `compress` simple..."'), "FAIL — expected raw assistant excerpt log line");
  assert.ok(text.includes("cmd: bun run pruner.test.ts -> ok"), "FAIL — expected command log line");
  assert.ok(text.includes('commit: ff104f4 "Refine DCP v2 block design"'), "FAIL — expected commit log line");
  assert.ok(!text.includes("m029"), "FAIL — visible message ids should not appear in normal rendered block text by default");

  console.log("  PASS: v2 block renderer emits a bounded factual activity log");
  console.log("TEST 15 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 16 — LEGACY V2 STATE RESTORES INTO NEW METADATA SHAPE
// ---------------------------------------------------------------------------
{
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
    state,
  );

  assert.strictEqual(state.schemaVersion, 2, "FAIL — restore should switch runtime state to schema v2");
  assert.strictEqual(state.compressionBlocksV2.length, 1, "FAIL — expected one restored v2 block");

  const block = state.compressionBlocksV2[0]!;
  assert.deepStrictEqual(block.metadata.supersededBlockIds, [1], "FAIL — legacy superseded block ids should migrate into hidden metadata");
  assert.deepStrictEqual(block.activityLog, [], "FAIL — missing activity log should normalize to an empty array");
  assert.deepStrictEqual(block.metadata.coveredSpanKeys, [], "FAIL — missing coveredSpanKeys should normalize to an empty array");
  assert.deepStrictEqual(block.metadata.commandStats, [], "FAIL — missing commandStats should normalize to an empty array");

  console.log("  PASS: legacy v2 scaffold state restores into the new metadata-rich shape");
  console.log("TEST 16 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 17 — LEGACY COMPRESS ARTIFACTS REUSE THE EXPANDED TOOL RANGE
// ---------------------------------------------------------------------------
{
  console.log("TEST 17: legacy compress artifacts include expanded assistant + tool metadata");

  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "please read the file" }], timestamp: 1000 },
    {
      role: "assistant",
      content: [
        { type: "text", text: "I'll inspect it." },
        { type: "toolCall", id: "toolu_read", name: "read", arguments: { path: "src/app.ts", offset: 10, limit: 5 } },
      ],
      timestamp: 2000,
    },
    {
      role: "toolResult",
      toolCallId: "toolu_read",
      toolName: "read",
      content: [{ type: "text", text: "file contents" }],
      isError: false,
      timestamp: 3000,
    },
    { role: "user", content: [{ type: "text", text: "thanks" }], timestamp: 4000 },
  ];

  const state = makeState();
  state.toolCalls.set("toolu_read", {
    toolCallId: "toolu_read",
    toolName: "read",
    inputArgs: { path: "src/app.ts", offset: 10, limit: 5 },
    inputFingerprint: "read::{}",
    isError: false,
    turnIndex: 0,
    timestamp: 3000,
    tokenEstimate: 10,
  });

  const artifacts = buildCompressionArtifactsForRange(messages, state, 3000, 3000);

  assert.deepStrictEqual(
    artifacts.activityLog.map((entry) => `${entry.kind}:${entry.text}`),
    [
      'assistant_excerpt:"I\'ll inspect it."',
      'read:src/app.ts#L10-L14',
    ],
    "FAIL — activity log should include the backward-expanded assistant excerpt and deterministic read record",
  );
  assert.deepStrictEqual(artifacts.metadata.coveredToolIds, ["toolu_read"], "FAIL — covered tool ids should include the read call");
  assert.deepStrictEqual(
    artifacts.metadata.fileReadStats,
    [{ path: "src/app.ts", count: 1, lineSpans: ["L10-L14"] }],
    "FAIL — file read stats should be populated from tool input args",
  );

  console.log("  PASS: legacy compress artifacts reuse expanded range coverage and tool metadata");
  console.log("TEST 17 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 17b — TOOL METADATA FALLS BACK TO COVERED ASSISTANT TOOLCALL BLOCKS
// ---------------------------------------------------------------------------
{
  console.log("TEST 17b: tool metadata recovers from assistant toolCall blocks");

  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "run bash" }], timestamp: 1000 },
    {
      role: "assistant",
      content: [
        { type: "text", text: "running" },
        { type: "toolCall", id: "toolu_bash", name: "bash", arguments: { command: "bun run test" } },
      ],
      timestamp: 2000,
    },
    {
      role: "bashExecution",
      toolCallId: "toolu_bash",
      toolName: "bash",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: 3000,
    },
  ];

  const artifacts = buildCompressionArtifactsForRange(messages, makeState(), 3000, 3000);

  assert.deepStrictEqual(
    artifacts.activityLog.map((entry) => `${entry.kind}:${entry.text}`),
    [
      'assistant_excerpt:"running"',
      'test:bun run test -> ok',
    ],
    "FAIL — tool metadata should be recovered from assistant toolCall blocks even without state.toolCalls",
  );
  assert.deepStrictEqual(
    artifacts.metadata.commandStats,
    [{ command: "bun run test", status: "ok" }],
    "FAIL — command stats should be populated from assistant toolCall arguments",
  );

  console.log("  PASS: covered assistant toolCall blocks recover missing tool metadata");
  console.log("TEST 17b PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 18 — RECENT TURN PROTECTION STARTS AT THE NTH-MOST-RECENT USER/ASSISTANT TURN
// ---------------------------------------------------------------------------
{
  console.log("TEST 18: recent-turn protection guards the hot conversational tail");

  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "one" }], timestamp: 1000 },
    { role: "assistant", content: [{ type: "text", text: "two" }], timestamp: 2000 },
    { role: "toolResult", toolCallId: "toolu_x", toolName: "read", content: [{ type: "text", text: "ignored" }], timestamp: 3000 },
    { role: "assistant", content: [{ type: "text", text: "three" }], timestamp: 4000 },
    { role: "bashExecution", toolCallId: "toolu_y", toolName: "bash", content: [{ type: "text", text: "ignored" }], timestamp: 5000 },
    { role: "user", content: [{ type: "text", text: "four" }], timestamp: 6000 },
  ];

  assert.strictEqual(
    resolveProtectedTailStartTimestamp(messages, 2),
    4000,
    "FAIL — protecting the last 2 user/assistant turns should start at timestamp 4000",
  );
  assert.strictEqual(
    resolveProtectedTailStartTimestamp(messages, 4),
    1000,
    "FAIL — when fewer than 4 conversational turns exist beyond the head, protection should extend to the earliest available turn",
  );
  assert.strictEqual(
    resolveProtectedTailStartTimestamp(messages, 0),
    null,
    "FAIL — zero protected turns should disable recent-turn protection",
  );

  console.log("  PASS: recent-turn protection is deterministic and assistant turns count");
  console.log("TEST 18 PASSED\n");
}

// ---------------------------------------------------------------------------
// Test 19 — PROVIDER PAYLOAD FILTER DROPS STALE COMPRESSED-AWAY TURN BUNDLES
// ---------------------------------------------------------------------------
{
  console.log("TEST 19: provider payload filter removes stale hidden bundles");

  const renderedMessages: any[] = [
    { role: "user", content: [{ type: "text", text: "current head\n<dcp-id>m001</dcp-id>" }] },
    { role: "user", content: [{ type: "text", text: "[Compressed section: archived]\n\nsummary\n\n<dcp-block-id>b1</dcp-block-id>" }] },
    { role: "user", content: [{ type: "text", text: "latest ask\n<dcp-id>m003</dcp-id>" }] },
  ];

  const payloadInput: any[] = [
    { role: "user", content: [{ type: "input_text", text: "current head\n<dcp-id>m001</dcp-id>" }] },
    { type: "reasoning", encrypted_content: "abc" },
    { role: "assistant", content: [{ type: "output_text", text: "current reply" }] },
    { role: "user", content: [{ type: "input_text", text: "stale raw turn\n<dcp-id>m002</dcp-id>" }] },
    { type: "reasoning", encrypted_content: "def" },
    { type: "function_call", name: "bash", call_id: "toolu_old" },
    { type: "function_call_output", call_id: "toolu_old", output: "ok" },
    { role: "assistant", content: [{ type: "output_text", text: "stale reply" }] },
    { role: "user", content: [{ type: "input_text", text: "[Compressed section: archived]\n\nsummary\n\n<dcp-block-id>b1</dcp-block-id>" }] },
    { role: "user", content: [{ type: "input_text", text: "latest ask\n<dcp-id>m003</dcp-id>" }] },
    { type: "reasoning", encrypted_content: "ghi" },
    { role: "assistant", content: [{ type: "output_text", text: "latest reply" }] },
  ];

  const filtered = filterProviderPayloadInput(payloadInput, renderedMessages);

  assert.strictEqual(filtered.length, 7, "FAIL — stale middle turn bundle should be removed entirely");
  assert.ok(
    !filtered.some((item: any) => item?.role === "user" && JSON.stringify(item.content).includes("m002")),
    "FAIL — stale raw user turn should have been removed",
  );
  assert.ok(
    !filtered.some((item: any) => item?.type === "function_call" && item.call_id === "toolu_old"),
    "FAIL — stale function_call should have been removed with its turn bundle",
  );
  assert.ok(
    filtered.some((item: any) => item?.role === "user" && JSON.stringify(item.content).includes("b1")),
    "FAIL — current compressed block should stay in the provider payload",
  );

  console.log("  PASS: provider payload filtering removes stale compressed-away payload history");
  console.log("TEST 19 PASSED\n");
}

console.log("All tests passed.");
