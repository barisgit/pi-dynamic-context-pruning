import { describe, expect, test } from "bun:test";
import {
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
  getNudgeType,
  makeConfig,
  makeMessages,
  makeState,
  renderCompressedBlockMessage,
  renderCompressionPlanningHints,
  resolveAnchorSourceKey,
  resolveAnchorTimestamp,
  resolveProtectedTailStartTimestamp,
  resolveSupersededBlockIdsForRange,
  restorePersistedState,
  validateCompressionRangeBoundaryIds,
} from "../helpers/dcp-test-utils.js";

describe("DCP debug.test", () => {
  // ---------------------------------------------------------------------------
  // Test 24 — SESSION DEBUG PAYLOAD EXPOSES SESSION IDS AND DIRECTORIES
  // ---------------------------------------------------------------------------
  test("Test 24 — SESSION DEBUG PAYLOAD EXPOSES SESSION IDS AND DIRECTORIES", () => {
    console.log("TEST 24: session debug payload exposes session ids and directories");

    const payload = buildSessionDebugPayload({
      getSessionId: () => "session-123",
      getCwd: () => "/repo",
      getSessionDir: () => "/sessions",
      getSessionFile: () => "/sessions/abc.jsonl",
      getLeafId: () => "entry-9",
    });

    expect(payload).toEqual({
      sessionId: "session-123",
      cwd: "/repo",
      sessionDir: "/sessions",
      sessionFile: "/sessions/abc.jsonl",
      leafId: "entry-9",
    });

    console.log("  PASS: session debug payload exposes session metadata");
    console.log("TEST 24 PASSED\n");
  });
});
