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

  // ---------------------------------------------------------------------------
  // Test 25 — DEBUG LOG APPENDS JSONL ENTRIES TO AN EXPLICIT FILE PATH
  // ---------------------------------------------------------------------------
  test("Test 25 — DEBUG LOG APPENDS JSONL ENTRIES TO AN EXPLICIT FILE PATH", () => {
    console.log("TEST 25: debug log appends JSONL entries to an explicit file path");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcp-debug-log-"));
    const logPath = path.join(tmpDir, "dcp.jsonl");

    appendDebugLogLine(logPath, "test_event", {
      nested: { ok: true },
      nonFinite: Infinity,
    });

    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    assert.strictEqual(lines.length, 1, "FAIL — debug log should append exactly one JSONL line");

    const entry = JSON.parse(lines[0]!);
    assert.strictEqual(entry.event, "test_event", "FAIL — debug log should persist the event name");
    assert.deepStrictEqual(
      entry.payload.nested,
      { ok: true },
      "FAIL — debug log should preserve nested payload objects"
    );
    assert.strictEqual(
      entry.payload.nonFinite,
      "Infinity",
      "FAIL — debug log should normalize non-finite numbers before serialization"
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });

    console.log("  PASS: debug log writes normalized JSONL entries");
    console.log("TEST 25 PASSED\n");
  });
});
