import { describe, expect, test } from "bun:test";
import { restoreStateFromBranch } from "../../src/application/session-handler.js";
import { serializePersistedState } from "../../src/infrastructure/persistence.js";
import type { CompressionBlock } from "../../src/types/state.js";
import { estimateTokens } from "../../src/domain/tokens/estimate.js";
import {
  applyPruning,
  buildTranscriptSnapshot,
  makeConfig,
  makeState,
  renderCompressedBlockMessage,
} from "../helpers/dcp-test-utils.js";

function messageEntry(message: any, id: string): any {
  return {
    type: "message",
    message,
    id,
    parentId: null,
    timestamp: new Date(message.timestamp).toISOString(),
  };
}

function dcpStateEntry(data: unknown, id = "dcp-state-after-compaction"): any {
  return {
    type: "custom",
    customType: "dcp-state",
    data,
    id,
    parentId: null,
    timestamp: new Date(7000).toISOString(),
  };
}

function nativeCompactionEntry(representedBlockIds: number[]): any {
  return {
    type: "compaction",
    summary: "native compaction baked DCP summaries into the rebuilt buffer",
    id: "native-compaction-1",
    parentId: null,
    timestamp: new Date(6000).toISOString(),
    details: {
      source: "dcp-native-compaction",
      version: 1,
      representedBlockIds,
      requestedBlockIds: representedBlockIds,
    },
  };
}

function textOf(messages: readonly any[]): string {
  return JSON.stringify(messages);
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

describe("resume restore parity", () => {
  test("restores active compression blocks directly from persisted state before pruning resumed context", () => {
    const LONG =
      "This early raw transcript content should be represented only by b1 after resume. ".repeat(
        80
      );
    const rawMessages = [
      {
        role: "user",
        content: [{ type: "text", text: `${LONG} alpha` }],
        timestamp: 1000,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: `${LONG} beta` }],
        timestamp: 2000,
      },
      {
        role: "user",
        content: [{ type: "text", text: `${LONG} gamma` }],
        timestamp: 3000,
      },
      {
        role: "user",
        content: [{ type: "text", text: "tail message after compressed range" }],
        timestamp: 4000,
      },
    ];
    const snapshot = buildTranscriptSnapshot(rawMessages);
    const coveredSourceKeys = snapshot.sourceItems.slice(0, 3).map((item) => item.key);
    const coveredSpanKeys = snapshot.spans.slice(0, 3).map((span) => span.key);
    const block: CompressionBlock = {
      id: 1,
      topic: "early raw range",
      summary: "b1 summary for the early raw range",
      startTimestamp: 1000,
      endTimestamp: 3000,
      anchorTimestamp: 4000,
      startSourceKey: coveredSourceKeys[0],
      endSourceKey: coveredSourceKeys.at(-1),
      anchorSourceKey: snapshot.sourceItems[3]?.key,
      active: true,
      summaryTokenEstimate: estimateTokens("b1 summary for the early raw range"),
      savedTokenEstimate: 1_000,
      createdAt: 5000,
      compressCallId: "call-compress-1",
      activityLogVersion: 1,
      activityLog: [{ kind: "user_excerpt", text: "early raw transcript content" }],
      metadata: {
        coveredSourceKeys,
        coveredSpanKeys,
        coveredArtifactRefs: [],
        coveredToolIds: [],
        supersededBlockIds: [],
        fileReadStats: [],
        fileWriteStats: [],
        commandStats: [],
      },
    };
    const savedState = makeState([block]);
    savedState.nextBlockId = 2;
    savedState.tokensSaved = 1_000;

    const compressAssistant = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-compress-1",
          name: "compress",
          arguments: {
            ranges: [
              {
                startId: "m0001",
                endId: "m0003",
                summary: "b1 summary for the early raw range",
                topic: "early raw range",
              },
            ],
          },
        },
      ],
      timestamp: 4500,
    };
    const compressResult = {
      role: "toolResult",
      toolCallId: "call-compress-1",
      toolName: "compress",
      content: [{ type: "text", text: "Compressed 1 range(s): b1" }],
      isError: false,
      timestamp: 5000,
    };
    const branch = [
      ...rawMessages.map((message, index) => messageEntry(message, `raw-${index + 1}`)),
      messageEntry(compressAssistant, "compress-call"),
      messageEntry(compressResult, "compress-result"),
      nativeCompactionEntry([99]),
      dcpStateEntry(serializePersistedState(savedState)),
    ];

    const config = makeConfig();
    const restored = makeState();
    restoreStateFromBranch(branch, restored, config);

    const resumeBuffer = rawMessages.map((message) => ({ ...message }));
    const rawEstimate = estimateTokens(textOf(resumeBuffer));
    const pruned = applyPruning(resumeBuffer, restored, config);
    const prunedText = textOf(pruned);

    expect(restored.compressionBlocks[0]?.active).toBe(true);
    expect(restored.compressionBlocks[0]?.metadata?.coveredSourceKeys.length ?? 0).toBeGreaterThan(
      0
    );
    expect(restored.tokensSaved).toBeGreaterThan(0);
    expect(prunedText).not.toContain("alpha");
    expect(prunedText).not.toContain("beta");
    expect(prunedText).not.toContain("gamma");
    expect(prunedText).toContain("[Compressed section: early raw range]");
    expect(prunedText).toContain("b1 summary for the early raw range");
    expect(estimateTokens(prunedText)).toBeLessThan(rawEstimate * 0.6);

    // Saved-token accounting must stay stable across repeated context passes:
    // each pass re-derives savings from a fresh raw buffer rather than
    // accumulating, so a second fresh buffer yields identical savings.
    const savedAfterFirstPass = restored.tokensSaved;
    const secondBuffer = rawMessages.map((message) => ({ ...message }));
    applyPruning(secondBuffer, restored, config);
    expect(restored.tokensSaved).toBe(savedAfterFirstPass);

    // On a real cross-resume, pi may already have baked the covered range into
    // a prior summary, so those raw messages are gone from the rebuilt buffer.
    // A restored active block whose coverage is absent must no-op cleanly: no
    // crash, no second summary, no resurrected raw messages, no balloon.
    const bakedResumeBuffer = [
      { ...renderCompressedBlockMessage(block), timestamp: 3999.5 },
      { ...rawMessages[3] },
    ];
    const prunedBaked = applyPruning(bakedResumeBuffer, restored, config);
    const prunedBakedText = textOf(prunedBaked);
    expect(countOccurrences(prunedBakedText, "[Compressed section: early raw range]")).toBe(1);
    expect(prunedBakedText).not.toContain("alpha");
    expect(prunedBakedText).not.toContain("beta");
    expect(prunedBakedText).not.toContain("gamma");
    expect(prunedBaked.length).toBe(2);
  });

  test("restores scalar continuity from a v3 snapshot when nothing compressed", () => {
    const config = makeConfig();
    const savedState = makeState();
    savedState.prunedToolIds = new Set(["tool-a", "tool-b"]);
    savedState.currentTurn = 12;
    savedState.lastNudgeTurn = 9;
    savedState.lastCompressTurn = 7;
    savedState.lifetimeTokensSavedRealized = 4321;

    const persisted = serializePersistedState(savedState);
    // No blocks were ever created, so serialization emits the tiny v3 scalar
    // marker rather than a coverage-bearing v5 snapshot.
    expect((persisted as { schemaVersion?: number }).schemaVersion).toBe(3);

    const branch = [dcpStateEntry(persisted, "dcp-state-v3")];
    const restored = makeState();
    const result = restoreStateFromBranch(branch, restored, config);

    // Direct-restore must recover scalar continuity even with no blocks, or a
    // resume silently drops dedup/error-purge tombstones and resets the nudge
    // debounce watermarks.
    expect(result.restoredStateEntries).toBe(1);
    expect(restored.compressionBlocks.length).toBe(0);
    expect(Array.from(restored.prunedToolIds).sort()).toEqual(["tool-a", "tool-b"]);
    expect(restored.currentTurn).toBe(12);
    expect(restored.lastNudgeTurn).toBe(9);
    expect(restored.lastCompressTurn).toBe(7);
    expect(restored.lifetimeTokensSavedRealized).toBe(4321);
  });
});
