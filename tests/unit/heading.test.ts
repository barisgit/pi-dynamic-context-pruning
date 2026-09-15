import { describe, expect, test } from "bun:test";
import { REMINDER_UPSERT_EVENT } from "pi-extension-utils";
import {
  createHeading,
  renderHeading,
  renderHeadingMessage,
  renderHeadingReminder,
} from "../../src/domain/compression/heading.js";
import {
  buildSourceItemKey,
  buildTranscriptSnapshot,
  countLogicalTurns,
  INTERNAL_HEADING,
} from "../../src/domain/transcript/index.js";
import { applyPruning, injectMessageIds } from "../../src/domain/pruning/index.js";
import { registerCompressTool } from "../../src/application/compress-tool/registration.js";
import { registerContextHandler } from "../../src/application/context-handler.js";
import {
  buildDcpNativeCompactionResult,
  buildDcpFallbackCustomInstructions,
  registerDcpNativeCompactionBridge,
} from "../../src/application/native-compaction.js";
import {
  serializePersistedState,
  restorePersistedState,
} from "../../src/infrastructure/persistence.js";
import { replayDcpState } from "../../src/domain/replay/index.js";
import { resetState } from "../../src/state.js";
import {
  makeConfig,
  makeState,
  buildCompressionArtifactsForRange,
} from "../helpers/dcp-test-utils.js";

const input = {
  goal: "Objective: .charters/example/charter.md",
  now: "The renderer passed tests; release approval remains.",
  next: "Request approval so the release can proceed.",
  constraints: "Do not commit.",
};
const heading = { ...input, revisedAfterId: "m0002", revisedAt: 2500 };
const user = (text: string, timestamp: number) => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp,
});
const messages = [
  user("old work ".repeat(200), 1000),
  user("raw before tail", 2000),
  user("hot tail", 3000),
];
const branch = messages.map((message, i) => ({
  type: "message" as const,
  id: `entry-${i}`,
  parentId: i ? `entry-${i - 1}` : null,
  timestamp: new Date(message.timestamp).toISOString(),
  message,
}));
function block(id = 1) {
  return {
    id,
    topic: "Historical work",
    summary: "The renderer passed tests.",
    startId: "m0001",
    endId: "m0001",
    startTimestamp: 1000,
    endTimestamp: 1000,
    anchorTimestamp: 2000,
    active: true,
    createdAt: 1500,
    summaryTokenEstimate: 10,
    metadata: buildCompressionArtifactsForRange(messages, makeState(), 1000, 1000).metadata,
  };
}
function harness() {
  const state = makeState();
  const config = makeConfig();
  config.compress.protectRecentTurns = 1;
  const saves: any[] = [];
  let tool: any;
  const pi = {
    registerTool(value: any) {
      tool = value;
    },
    appendEntry(type: string, data: unknown) {
      saves.push({ type, data });
    },
  };
  const ctx = {
    getContextUsage: () => ({ tokens: 0, contextWindow: 100_000 }),
    hasUI: false,
    ui: { notify() {}, setStatus() {} },
    sessionManager: {
      getBranch: () => branch,
      getLeafId: () => null,
      getSessionId: () => "heading-test",
      getCwd: () => "/tmp",
      getSessionDir: () => "/tmp",
      getSessionFile: () => undefined,
    },
  };
  applyPruning(messages, state, config);
  registerCompressTool(pi as any, state, config);
  return {
    state,
    config,
    saves,
    ctx,
    tool,
    execute: (params: any) => tool.execute("heading-call", params, undefined, undefined, ctx),
  };
}

describe("mutable heading", () => {
  test("heading-only call replaces whole heading and flushes v5 without blocks", async () => {
    const h = harness();
    expect(h.tool.parameters.required ?? []).not.toContain("ranges");
    const result = await h.execute({ heading: input });
    expect(result.content[0].text).toBe("Heading replaced.");
    expect(h.state.heading).toMatchObject({ ...input, revisedAfterId: "m0003" });
    expect(h.state.compressionBlocks).toHaveLength(0);
    expect(h.saves.at(-1).data).toMatchObject({
      schemaVersion: 5,
      blocks: [],
      heading: h.state.heading,
    });
    await h.execute({ heading: { goal: "New goal", now: "New gap", next: "New step" } });
    expect(h.state.heading?.constraints).toBeUndefined();
    expect(h.state.heading?.goal).toBe("New goal");
    await expect(h.execute({})).rejects.toThrow("Provide heading or at least one range.");
  });

  test("rejects over-budget heading with actual count; never truncates or mutates", async () => {
    const h = harness();
    await h.execute({ heading: input });
    const previous = h.state.heading;
    await expect(
      h.execute({ heading: { goal: "g".repeat(998), now: "n", next: "x", constraints: "!" } })
    ).rejects.toThrow("1001 characters; maximum is 1000");
    expect(h.state.heading).toBe(previous);
    await h.execute({ heading: { goal: "g".repeat(998), now: "n", next: "x" } });
    expect(h.state.heading?.goal).toHaveLength(998);
    await expect(
      h.execute({
        heading: input,
        ranges: [{ startId: "m9999", endId: "m9999", topic: "bad", summary: "Rejected." }],
      })
    ).rejects.toThrow();
    expect(h.state.heading?.goal).toHaveLength(998);
  });

  test("v5 round trips heading and old state restores undefined", () => {
    for (const blocks of [[], [block()]]) {
      const state = makeState(blocks);
      state.heading = heading;
      const data = JSON.parse(JSON.stringify(serializePersistedState(state)));
      expect(data.schemaVersion).toBe(5);
      const restored = makeState();
      restorePersistedState(data, restored);
      expect(restored.heading).toEqual(heading);
      delete data.heading;
      restorePersistedState(data, restored);
      expect(restored.heading).toBeUndefined();
      restored.heading = heading;
      resetState(restored);
      expect(restored.heading).toBeUndefined();
    }
  });

  test("renders exact full heading once after older raw work and before protected tail", () => {
    const h = harness();
    h.state.compressionBlocks = [block()];
    h.state.heading = heading;
    const rendered = applyPruning(messages, h.state, h.config);
    const expected =
      '<heading revised-after="m0002">\nGoal: Objective: .charters/example/charter.md\n\nNow: The renderer passed tests; release approval remains.\n\nNext: Request approval so the release can proceed.\n\nConstraints: Do not commit.\n</heading>';
    expect(renderHeading(heading)).toBe(expected);
    expect(rendered.map((message) => Boolean(message[INTERNAL_HEADING]))).toEqual([
      false,
      false,
      true,
      false,
    ]);
    expect(rendered[2].role).toBe("user");
    expect(rendered[2].content[0].text).toBe(expected);
    expect(JSON.stringify(rendered[0])).toContain(
      "Record m0001–m0001 (ended 1970-01-01T00:00:01.000Z)"
    );
    expect(JSON.stringify(rendered[1])).toContain("raw before tail");
    expect(JSON.stringify(rendered[3])).toContain("hot tail");
    expect(
      renderHeading({ goal: "g", now: "n", next: "x", revisedAfterId: "m0001", revisedAt: 1 })
    ).not.toContain("Constraints:");
    const again = applyPruning(messages, h.state, h.config);
    expect(again.filter((message) => message[INTERNAL_HEADING])).toHaveLength(1);
    expect(h.state.currentTurn).toBe(3);
  });

  test("heading stays outside tool batches, refs, pruning, and logical turns", () => {
    const h = harness();
    h.state.heading = heading;
    const exchange = [
      messages[0],
      {
        role: "assistant",
        timestamp: 2000,
        content: [{ type: "toolCall", id: "read", name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        timestamp: 3000,
        toolCallId: "read",
        toolName: "read",
        content: [{ type: "text", text: "output" }],
      },
    ];
    h.state.prunedToolIds.add("read");
    const rendered = applyPruning(exchange, h.state, h.config);
    expect(rendered[1][INTERNAL_HEADING]).toBe(true);
    expect(rendered[2].role).toBe("assistant");
    expect(rendered[3].role).toBe("toolResult");
    expect(rendered[1].content[0].text).toBe(renderHeading(heading));
    const synthetic = renderHeadingMessage(heading);
    expect(buildSourceItemKey(synthetic, 999)).toBe("synth:heading");
    expect(buildTranscriptSnapshot([messages[0], synthetic]).sourceItems).toHaveLength(1);
    expect(countLogicalTurns([messages[0], synthetic])).toBe(1);
    injectMessageIds([synthetic], h.state);
    expect(h.state.messageRefSnapshot.size).toBe(0);
    const inputWithHeading = [messages[0], synthetic, ...messages.slice(1)];
    const result = applyPruning(inputWithHeading, h.state, h.config);
    expect(result.filter((message) => message[INTERNAL_HEADING])).toHaveLength(1);
    expect(h.state.currentTurn).toBe(3);
  });

  test("native override and fallback seed put heading first and never drop it for budget", async () => {
    const h = harness();
    h.state.heading = heading;
    h.state.compressionBlocks = [block()];
    const args = {
      state: h.state,
      config: h.config,
      branchEntries: branch as any,
      preparation: { firstKeptEntryId: "entry-1", tokensBefore: 1000 },
      request: { id: "req", reason: "command" as const, requestedAt: 4000 },
    };
    const expected = renderHeading(heading);
    const summary = buildDcpNativeCompactionResult(args).summary;
    expect(summary.startsWith(expected)).toBe(true);
    expect(summary.indexOf("Historical work")).toBeGreaterThan(summary.indexOf("</heading>"));
    expect(buildDcpFallbackCustomInstructions(h.state)?.startsWith(expected)).toBe(true);
    h.config.nativeCompaction.maxSummaryTokens = 1;
    expect(buildDcpNativeCompactionResult(args).summary.startsWith(expected)).toBe(true);
    expect(buildDcpNativeCompactionResult(args).summary).toBe(expected);
    const handlers = new Map<string, any>();
    registerDcpNativeCompactionBridge(
      { on: (name: string, handler: any) => handlers.set(name, handler) } as any,
      h.state,
      h.config
    );
    const result = await handlers.get("session_before_compact")(
      { branchEntries: branch, preparation: args.preparation },
      h.ctx
    );
    expect(result.compaction.summary.startsWith(expected)).toBe(true);
    const materialized = applyPruning(
      [{ role: "compactionSummary", summary, timestamp: 4000 }, messages[2]],
      h.state,
      h.config
    );
    expect(JSON.stringify(materialized).split("<heading ")).toHaveLength(2);
    const next = buildDcpNativeCompactionResult({
      ...args,
      preparation: { ...args.preparation, previousSummary: summary },
    });
    expect(next.summary.split("<heading ")).toHaveLength(2);
  });

  test("staleness counts logical turns rather than visible IDs and supports missing heading", () => {
    const h = harness();
    h.state.heading = heading;
    const later = [
      ...messages,
      {
        role: "assistant",
        timestamp: 4000,
        content: [
          { type: "toolCall", id: "a", name: "read", arguments: {} },
          { type: "toolCall", id: "b", name: "read", arguments: {} },
        ],
      },
      { role: "toolResult", toolCallId: "a", timestamp: 5000 },
      { role: "toolResult", toolCallId: "b", timestamp: 6000 },
    ];
    expect(renderHeadingReminder(h.state, later)).toBe(
      "Heading revised after m0002 (2 turns ago) — replace it if it no longer matches where the work is."
    );
    const restored = makeState();
    restorePersistedState(JSON.parse(JSON.stringify(serializePersistedState(h.state))), restored);
    expect(renderHeadingReminder(restored, later)).toContain("(2 turns ago)");
    h.state.heading = undefined;
    expect(renderHeadingReminder(h.state, messages)).toBe("");
    h.state.compressionBlocks = [block()];
    expect(renderHeadingReminder(h.state, messages)).toBe("");
    h.state.compressionBlocks.push(block(2));
    expect(renderHeadingReminder(h.state, messages)).toBe(
      "No heading. Write one: goal, now, next."
    );
  });

  test("context reminder appends one heading line after candidate ranges", async () => {
    for (const hasHeading of [true, false]) {
      const h = harness();
      h.config.compress.minContextPercent = 0.1;
      h.state.heading = hasHeading ? heading : undefined;
      h.state.compressionBlocks = [block(), block(2)];
      const emitted: any[] = [];
      const handlers = new Map<string, any>();
      const pi = {
        on: (name: string, fn: any) => handlers.set(name, fn),
        events: {
          on() {
            return () => {};
          },
          emit(name: string, payload: any) {
            emitted.push({ name, payload });
          },
        },
      };
      registerContextHandler(pi as any, h.state, h.config);
      await handlers.get("context")(
        { messages },
        { ...h.ctx, getContextUsage: () => ({ tokens: 90_000, contextWindow: 100_000 }) }
      );
      const text = emitted.find((e) => e.name === REMINDER_UPSERT_EVENT).payload.text as string;
      const line = hasHeading
        ? "Heading revised after m0002 (1 turns ago) — replace it if it no longer matches where the work is."
        : "No heading. Write one: goal, now, next.";
      expect(text.endsWith(line)).toBe(true);
      expect(text.split(line)).toHaveLength(2);
    }
  });

  test("offline replay handles heading-only success", () => {
    const state = replayDcpState(
      [
        { type: "message", message: messages[0] },
        {
          type: "message",
          message: {
            role: "assistant",
            timestamp: 2000,
            content: [
              { type: "toolCall", id: "h", name: "compress", arguments: { heading: input } },
            ],
          },
        },
        {
          type: "message",
          message: {
            role: "toolResult",
            timestamp: 3000,
            toolCallId: "h",
            toolName: "compress",
            content: [{ type: "text", text: "Heading replaced." }],
          },
        },
      ],
      makeConfig()
    );
    expect(state.heading).toEqual({ ...input, revisedAfterId: "m0001", revisedAt: 2000 });
    expect(state.compressionBlocks).toHaveLength(0);
  });
});
