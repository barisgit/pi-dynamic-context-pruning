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
  exceedsMaxContextLimit,
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

describe("DCP nudge.test", () => {
  // ---------------------------------------------------------------------------
  // Test 11 — NUDGE INJECTION SHOULD ANCHOR TO EXISTING MESSAGE
  //
  // Reminders should not be appended as a fresh terminal user message because
  // that hijacks recency and focus. They should attach to the latest visible
  // user/assistant message when possible.
  // ---------------------------------------------------------------------------
  test("Test 11 — NUDGE INJECTION SHOULD ANCHOR TO EXISTING MESSAGE", () => {
    console.log("TEST 11: nudge injection anchors to existing message");

    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "do the thing" }], timestamp: 1000 },
      { role: "assistant", content: [{ type: "text", text: "working" }], timestamp: 2000 },
    ];

    injectNudge(messages, "<dcp-system-reminder>compress maybe</dcp-system-reminder>");

    assert.strictEqual(
      messages.length,
      2,
      "FAIL — injectNudge should not append a new message when an anchor exists"
    );
    assert.strictEqual(
      messages[1]?.role,
      "assistant",
      "FAIL — last message role should stay assistant"
    );

    const content = messages[1]?.content;
    const joined = Array.isArray(content)
      ? content.map((part: any) => part?.text ?? "").join("\n")
      : String(content ?? "");

    assert.ok(
      joined.includes("<dcp-system-reminder>compress maybe</dcp-system-reminder>"),
      "FAIL — anchored nudge text missing from assistant message"
    );
    console.log("  PASS: reminder attached to existing assistant message");

    console.log("TEST 11 PASSED\n");
  });

  // ---------------------------------------------------------------------------
  // Test 13 — TURN NUDGES SHOULD RESPECT TURN DEBOUNCE AND COMPRESS COOL-DOWN
  // ---------------------------------------------------------------------------
  test("Test 13 — TURN NUDGES SHOULD RESPECT TURN DEBOUNCE AND COMPRESS COOL-DOWN", () => {
    console.log("TEST 13: turn nudge debounce + post-compress suppression");

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
      "FAIL — should not emit a turn nudge twice in the same logical turn"
    );

    state.currentTurn = 6;
    state.lastNudgeTurn = 5;
    assert.strictEqual(
      getNudgeType(0.8, state, config, 0),
      null,
      "FAIL — should debounce for one newer logical turn when debounceTurns=2"
    );

    state.currentTurn = 7;
    state.lastNudgeTurn = 5;
    assert.strictEqual(
      getNudgeType(0.8, state, config, 0),
      "turn",
      "FAIL — should emit once enough newer logical turns have happened"
    );
    assert.strictEqual(
      getNudgeType(0.75, state, config, 0),
      "turn",
      "FAIL — hitting the exact minimum threshold should now be enough to emit a nudge"
    );

    state.currentTurn = 7;
    state.lastCompressTurn = 7;
    state.lastNudgeTurn = 7;
    assert.strictEqual(
      getNudgeType(0.95, state, config, 0),
      null,
      "FAIL — should not emit in the same logical turn that already compressed"
    );

    state.currentTurn = 8;
    assert.strictEqual(
      getNudgeType(0.95, state, config, 0),
      null,
      "FAIL — should stay quiet on the first newer logical turn after compress when debounceTurns=2"
    );

    state.currentTurn = 9;
    assert.strictEqual(
      getNudgeType(0.95, state, config, 0),
      "context-soft",
      "FAIL — should re-emit once compress cool-down and debounce are both satisfied"
    );

    console.log("  PASS: turn debounce and post-compress suppression work");
    console.log("TEST 13 PASSED\n");
  });

  test("token thresholds are ORed with percent thresholds", () => {
    const config = makeConfig();
    config.compress.minContextPercent = 0.75;
    config.compress.maxContextPercent = 0.9;
    config.compress.minContextTokens = 150_000;
    config.compress.maxContextTokens = 200_000;

    const state = makeState();
    state.currentTurn = 5;
    state.lastNudgeTurn = -1;

    assert.strictEqual(
      getNudgeType(0.2, state, config, 0, 149_999),
      null,
      "FAIL — should stay quiet below both percent and token minimum thresholds"
    );
    assert.strictEqual(
      getNudgeType(0.2, state, config, 0, 150_000),
      "turn",
      "FAIL — absolute token minimum should allow nudges even when percent is low"
    );
    assert.strictEqual(
      getNudgeType(0.2, state, config, 0, 200_001),
      "context-soft",
      "FAIL — absolute token maximum should trigger context nudge even when percent is low"
    );
    assert.strictEqual(
      exceedsMaxContextLimit(0.2, config, 200_001),
      true,
      "FAIL — hot-tail emergency override should honor maxContextTokens"
    );
  });
});
