import { describe, expect, test } from "bun:test";
import { materializeContextMessages } from "../../src/application/context-handler.js";
import { filterProviderPayloadInput } from "../../src/domain/provider/payload-filter.js";
import { applyPruning } from "../../src/domain/pruning/index.js";
import {
  buildBlockOwnerKey,
  buildSourceOwnerKey,
  buildTranscriptSnapshot,
} from "../../src/domain/transcript/index.js";
import { createEmptyCompressionBlockMetadata } from "../../src/state.js";
import type { CompressionBlock, CompressionBlockV2 } from "../../src/types/state.js";
import {
  findOrphanedToolUse,
  makeConfig,
  makeMessages,
  makeState,
} from "../helpers/dcp-test-utils.js";

function makeLegacyToolBlock(): CompressionBlock {
  return {
    id: 4,
    topic: "legacy tool work",
    summary: "legacy summary",
    startTimestamp: 2000,
    endTimestamp: 3000,
    anchorTimestamp: 4000,
    active: true,
    summaryTokenEstimate: 5,
    savedTokenEstimate: 0,
    createdAt: 10,
    activityLogVersion: 1,
    activityLog: [],
    metadata: createEmptyCompressionBlockMetadata(),
  };
}

function makeV2ToolBlock(messages = makeMessages()): CompressionBlockV2 {
  const snapshot = buildTranscriptSnapshot(messages);
  return {
    id: 7,
    topic: "v2 tool work",
    summary: "v2 summarized the assistant tool call and result",
    startSpanKey: snapshot.spans[1]!.key,
    endSpanKey: snapshot.spans[1]!.key,
    status: "active",
    summaryTokenEstimate: 8,
    createdAt: 10,
    activityLogVersion: 1,
    activityLog: [],
    metadata: {
      ...createEmptyCompressionBlockMetadata(),
      coveredSourceKeys: snapshot.spans[1]!.sourceKeys,
      coveredSpanKeys: [snapshot.spans[1]!.key],
      coveredToolIds: ["toolu_abc"],
    },
  };
}

function textOf(message: any): string {
  return Array.isArray(message.content)
    ? message.content.map((part: any) => part?.text ?? "").join("\n")
    : String(message.content ?? "");
}

describe("context materialization routing", () => {
  test("schema v1 still uses the existing applyPruning path", () => {
    const messages = makeMessages();
    const config = makeConfig();
    const directState = makeState([makeLegacyToolBlock()]);
    const routedState = makeState([makeLegacyToolBlock()]);

    const direct = applyPruning(messages, directState, config);
    const routed = materializeContextMessages(messages, routedState, config);

    expect(routed.mode).toBe("v1");
    expect(routed.renderedV2BlockIds).toEqual([]);
    expect(routed.messages).toEqual(direct);
    expect(routedState.messageOwnerSnapshot).toEqual(directState.messageOwnerSnapshot);
  });

  test("v1 finalization preserves source owners for messages after a compressed range", () => {
    const messages = [
      ...makeMessages(),
      {
        role: "user",
        content: [{ type: "text", text: "continue after compression" }],
        timestamp: 5000,
      },
      { role: "assistant", content: [{ type: "text", text: "still visible" }], timestamp: 6000 },
    ];
    const state = makeState([makeLegacyToolBlock()]);

    const routed = materializeContextMessages(messages, state, makeConfig());
    const providerFiltered = filterProviderPayloadInput(
      routed.messages as any[],
      routed.liveOwnerKeys,
      state.compressionBlocks,
      state.messageOwnerSnapshot
    );

    expect(routed.liveOwnerKeys.has(buildSourceOwnerKey(4))).toBe(true);
    expect(routed.liveOwnerKeys.has(buildSourceOwnerKey(5))).toBe(true);
    expect([...state.messageOwnerSnapshot.values()]).toContain(buildSourceOwnerKey(4));
    expect([...state.messageOwnerSnapshot.values()]).toContain(buildSourceOwnerKey(5));
    expect(providerFiltered).toHaveLength(routed.messages.length);
    expect(
      providerFiltered.some((message: any) =>
        textOf(message).includes("continue after compression")
      )
    ).toBe(true);
    expect(providerFiltered.some((message: any) => textOf(message).includes("still visible"))).toBe(
      true
    );
  });

  test("schema v2 renders an active span block through the context path", () => {
    const messages = makeMessages();
    const config = makeConfig();
    const state = makeState();
    state.schemaVersion = 2;
    state.compressionBlocksV2 = [makeV2ToolBlock(messages)];

    const routed = materializeContextMessages(messages, state, config);

    expect(routed.mode).toBe("v2");
    expect(routed.renderedV2BlockIds).toEqual([7]);
    expect(routed.messages).toHaveLength(3);
    expect(textOf(routed.messages[1])).toContain("[Compressed section: v2 tool work]");
    expect(textOf(routed.messages[1])).toContain(
      "v2 summarized the assistant tool call and result"
    );
    expect(state.messageRefSnapshot.size).toBeGreaterThan(0);
  });

  test("v2 live owner keys include the active block and exclude covered source owners", () => {
    const messages = makeMessages();
    const state = makeState();
    state.schemaVersion = 2;
    state.compressionBlocksV2 = [makeV2ToolBlock(messages)];

    const routed = materializeContextMessages(messages, state, makeConfig());

    expect(routed.liveOwnerKeys.has(buildBlockOwnerKey(7))).toBe(true);
    expect(routed.liveOwnerKeys.has(buildSourceOwnerKey(0))).toBe(true);
    expect(routed.liveOwnerKeys.has(buildSourceOwnerKey(1))).toBe(false);
    expect(routed.liveOwnerKeys.has(buildSourceOwnerKey(2))).toBe(false);
    expect(routed.liveOwnerKeys.has(buildSourceOwnerKey(3))).toBe(true);
  });

  test("v2 message owner snapshot maps the synthetic block ref to block owner", () => {
    const messages = makeMessages();
    const state = makeState();
    state.schemaVersion = 2;
    state.compressionBlocksV2 = [makeV2ToolBlock(messages)];

    materializeContextMessages(messages, state, makeConfig());

    const blockRef = [...state.messageOwnerSnapshot.entries()].find(
      ([, ownerKey]) => ownerKey === buildBlockOwnerKey(7)
    )?.[0];

    expect(blockRef).toBeDefined();
    expect(state.messageRefSnapshot.get(blockRef!)?.ownerKey).toBe(buildBlockOwnerKey(7));
  });

  test("v2 block covering a tool exchange leaves no orphaned assistant/tool result", () => {
    const messages = makeMessages();
    const state = makeState();
    state.schemaVersion = 2;
    state.compressionBlocksV2 = [makeV2ToolBlock(messages)];

    const routed = materializeContextMessages(messages, state, makeConfig());

    expect(findOrphanedToolUse(routed.messages)).toBeNull();
    expect(routed.messages.some((message: any) => message.role === "toolResult")).toBe(false);
    expect(
      routed.messages.some(
        (message: any) =>
          message.role === "assistant" &&
          Array.isArray(message.content) &&
          message.content.some((part: any) => part?.type === "toolCall")
      )
    ).toBe(false);
  });
});
