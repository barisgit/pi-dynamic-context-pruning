import { describe, expect, test } from "bun:test";
import {
  applyPruning,
  selectRetainedCompressionBlockDetails,
} from "../../src/domain/pruning/index.ts";
import {
  restorePersistedState,
  serializePersistedState,
} from "../../src/infrastructure/persistence.ts";
import type { CompressionBlock } from "../../src/types/state.ts";
import {
  buildCompressionArtifactsForRange,
  createEmptyCompressionBlockMetadata,
  makeConfig,
  makeState,
} from "../helpers/dcp-test-utils.ts";

function makeBlock(id: number): CompressionBlock {
  const metadata = createEmptyCompressionBlockMetadata();
  metadata.effectStats = {
    reads: id,
    searches: 0,
    mutations: 1,
    commands: 0,
    delegations: 0,
  };
  metadata.fileWriteStats = [
    {
      path: `src/block-${id}.ts`,
      editCount: 1,
      addedLines: 1,
      removedLines: 0,
    },
  ];
  return {
    id,
    topic: `block ${id}`,
    summary: `summary-${id}-${`authored detail ${id} `.repeat(80)}`,
    startTimestamp: id * 1000,
    endTimestamp: id * 1000,
    anchorTimestamp: id * 1000 + 500,
    active: true,
    summaryTokenEstimate: 100,
    savedTokenEstimate: 50,
    createdAt: id * 1000,
    activityLogVersion: 1,
    activityLog: [
      { kind: "user_excerpt", text: `conversation-${id}` },
      { kind: "command", text: `command-${id}` },
    ],
    metadata,
  };
}

function sourceMessages(): any[] {
  return [1, 2, 3, 4].map((id) => ({
    role: "user",
    content: [{ type: "text", text: `raw-${id}` }],
    timestamp: id * 1000,
  }));
}

function renderedText(messages: any[]): string {
  return messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .map((part) => part?.text ?? "")
    .join("\n");
}

function messageEntry(id: string, message: any, parentId: string | null): any {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(message.timestamp).toISOString(),
    message,
  };
}

function makeCanonicalHistory(): {
  blocks: CompressionBlock[];
  messages: any[];
  entries: any[];
  firstOlderEntryId: string;
  tailEntryId: string;
} {
  // Newer canonical blocks occupy the hidden prefix; older blocks deliberately
  // remain in the retained tail after the checkpoint commits the prefix.
  const sourceOrder = [
    ...Array.from({ length: 12 }, (_, index) => index + 11),
    ...Array.from({ length: 10 }, (_, index) => index + 1),
  ];
  const messages: any[] = [];
  const ranges = new Map<number, { start: number; end: number }>();

  sourceOrder.forEach((id, index) => {
    const start = (index + 1) * 1000;
    ranges.set(id, { start, end: start + 100 });
    messages.push(
      {
        role: "assistant",
        content: [{ type: "toolCall", id: `call-${id}`, name: "read", arguments: { id } }],
        timestamp: start,
      },
      {
        role: "toolResult",
        toolCallId: `call-${id}`,
        toolName: "read",
        content: [{ type: "text", text: `COVERED_RAW_${id}` }],
        isError: false,
        timestamp: start + 100,
      }
    );
  });
  messages.push({
    role: "user",
    content: [{ type: "text", text: "retained checkpoint tail" }],
    timestamp: 30_000,
  });

  const blocks = Array.from({ length: 22 }, (_, index): CompressionBlock => {
    const id = index + 1;
    const range = ranges.get(id)!;
    const artifacts = buildCompressionArtifactsForRange(
      messages,
      makeState(),
      range.start,
      range.end
    );
    return {
      id,
      topic: `block ${id}`,
      summary: `CANONICAL_SUMMARY_${id}_END`,
      startTimestamp: range.start,
      endTimestamp: range.end,
      anchorTimestamp: range.end + 1,
      startSourceKey: artifacts.metadata.coveredSourceKeys[0],
      endSourceKey: artifacts.metadata.coveredSourceKeys.at(-1),
      anchorSourceKey: `tail:${range.end}`,
      active: true,
      summaryTokenEstimate: 8,
      savedTokenEstimate: 20,
      createdAt: id,
      compressCallId: `compress-${id}`,
      activityLogVersion: 1,
      activityLog: [{ kind: "user_excerpt", text: `FULL_ONLY_${id}` }],
      metadata: artifacts.metadata,
    };
  });

  const entries = messages.map((message, index) =>
    messageEntry(`entry-${index}`, message, index === 0 ? null : `entry-${index - 1}`)
  );
  return {
    blocks,
    messages,
    entries,
    firstOlderEntryId: "entry-24",
    tailEntryId: `entry-${entries.length - 1}`,
  };
}

describe("compression block retention tiers", () => {
  test("renders newest full, next compact, and omits whole older blocks while hiding covered raw", () => {
    const config = makeConfig();
    config.compress.renderFullBlockCount = 1;
    config.compress.renderCompactBlockCount = 1;
    const state = makeState([1, 2, 3, 4].map(makeBlock));

    const result = applyPruning(sourceMessages(), state, config);
    const text = renderedText(result);

    expect(text).toContain("summary-4-");
    expect(text).toContain("conversation-4");
    expect(text).toContain("<effects>");
    expect(text).toContain("src/block-4.ts");

    expect(text).toContain("summary-3-");
    expect(text).toContain("authored detail 3 ".repeat(80).trim());
    expect(text).not.toContain("conversation-3");
    expect(text).not.toContain("src/block-3.ts");

    expect(text).not.toContain("summary-2-");
    expect(text).not.toContain("summary-1-");
    for (const id of [1, 2, 3, 4]) expect(text).not.toContain(`raw-${id}`);

    expect(state.compressionBlocks).toHaveLength(4);
    expect(state.compressionBlocks.every((block) => block.active)).toBe(true);
  });

  test("applies the same tiers automatically after a v5 restore", () => {
    const config = makeConfig();
    config.compress.renderFullBlockCount = 1;
    config.compress.renderCompactBlockCount = 1;
    const persisted = serializePersistedState(makeState([1, 2, 3, 4].map(makeBlock)));
    expect(persisted.schemaVersion).toBe(5);

    const restored = makeState();
    restorePersistedState(persisted, restored);
    const text = renderedText(applyPruning(sourceMessages(), restored, config));

    expect(text).toContain("summary-4-");
    expect(text).toContain("conversation-4");
    expect(text).toContain("summary-3-");
    expect(text).not.toContain("conversation-3");
    expect(text).not.toContain("summary-2-");
    expect(text).not.toContain("summary-1-");
    expect(restored.compressionBlocks).toHaveLength(4);
    expect(restored.compressionBlocks.every((block) => block.active)).toBe(true);
  });
});
