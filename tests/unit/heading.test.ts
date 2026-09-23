import { describe, expect, test } from "bun:test";
import { REMINDER_UPSERT_EVENT } from "pi-extension-utils";
import { renderHeading, renderHeadingMessage } from "../../src/domain/compression/heading.js";
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
  test("live schema requires ranges and rejects heading-only calls without mutation", async () => {
    const h = harness();
    h.state.heading = heading;
    expect(h.tool.parameters.required).toContain("ranges");
    expect(h.tool.parameters.properties.heading).toBeUndefined();
    expect(h.tool.parameters.properties.ranges.minItems).toBe(1);
    await expect(h.execute({ heading: input })).rejects.toThrow("Provide at least one range");
    await expect(h.execute({ ranges: [] })).rejects.toThrow("Provide at least one range");
    expect(h.state.heading).toEqual(heading);
    expect(h.saves).toHaveLength(0);
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

  test("renders exact full heading for compaction without injecting it into ordinary context", () => {
    const h = harness();
    h.state.compressionBlocks = [block()];
    h.state.heading = heading;
    const rendered = applyPruning(messages, h.state, h.config);
    const expected =
      '<heading revised-after="m0002">\nGoal: Objective: .charters/example/charter.md\n\nNow: The renderer passed tests; release approval remains.\n\nNext: Request approval so the release can proceed.\n\nConstraints: Do not commit.\n</heading>';
    expect(renderHeading(heading)).toBe(expected);
    expect(rendered).toHaveLength(3);
    expect(rendered.some((message) => message[INTERNAL_HEADING])).toBe(false);
    expect(JSON.stringify(rendered)).not.toContain("<heading ");
    expect(JSON.stringify(rendered[0])).toContain(
      "Record m0001–m0001 (ended 1970-01-01T00:00:01.000Z)"
    );
    expect(JSON.stringify(rendered[1])).toContain("raw before tail");
    expect(JSON.stringify(rendered[2])).toContain("hot tail");
    expect(
      renderHeading({ goal: "g", now: "n", next: "x", revisedAfterId: "m0001", revisedAt: 1 })
    ).not.toContain("Constraints:");
    expect(applyPruning(messages, h.state, h.config)).toEqual(rendered);
    expect(h.state.currentTurn).toBe(3);
  });

  test("ordinary tool calls preserve the rendered prefix even when heading state changes", () => {
    for (const blocks of [[], [block()]]) {
      const h = harness();
      h.state.compressionBlocks = blocks;
      h.state.heading = heading;
      const source: any[] = [...messages];
      let previous = applyPruning(source, h.state, h.config);
      for (let i = 0; i < 3; i++) {
        source.push(
          {
            role: "assistant",
            timestamp: 4000 + i * 2000,
            content: [{ type: "toolCall", id: `read-${i}`, name: "read", arguments: {} }],
          },
          {
            role: "toolResult",
            timestamp: 5000 + i * 2000,
            toolCallId: `read-${i}`,
            toolName: "read",
            content: [{ type: "text", text: `output ${i}` }],
          }
        );
        const rendered = applyPruning(source, h.state, h.config);
        expect(JSON.stringify(rendered.slice(0, previous.length))).toBe(JSON.stringify(previous));
        expect(rendered).toHaveLength(previous.length + 2);
        expect(rendered.slice(-2).map((message) => message.role)).toEqual([
          "assistant",
          "toolResult",
        ]);
        h.state.heading = {
          ...heading,
          now: `Completed tool call ${i}.`,
          revisedAt: 5000 + i * 2000,
        };
        expect(applyPruning(source, h.state, h.config)).toEqual(rendered);
        previous = rendered;
      }
      expect(h.state.currentTurn).toBe(6);
    }
  });

  test("legacy synthetic headings stay outside refs, pruning, and logical turns", () => {
    const h = harness();
    h.state.heading = heading;
    const synthetic = renderHeadingMessage(heading);
    expect(buildSourceItemKey(synthetic, 999)).toBe("synth:heading");
    expect(buildTranscriptSnapshot([messages[0], synthetic]).sourceItems).toHaveLength(1);
    expect(countLogicalTurns([messages[0], synthetic])).toBe(1);
    injectMessageIds([synthetic], h.state);
    expect(h.state.messageRefSnapshot.size).toBe(0);
    const inputWithHeading = [messages[0], synthetic, ...messages.slice(1)];
    const result = applyPruning(inputWithHeading, h.state, h.config);
    expect(result.filter((message) => message[INTERNAL_HEADING])).toHaveLength(0);
    expect(h.state.currentTurn).toBe(3);
  });

  test("legacy heading remains stored while fresh orientation replaces history and budget uses fallback", async () => {
    const h = harness();
    h.state.heading = heading;
    h.state.compressionBlocks = [block()];
    const args = {
      state: h.state,
      config: h.config,
      branchEntries: branch as any,
      preparation: { firstKeptEntryId: "entry-1", tokensBefore: 1000 },
      request: { id: "req", reason: "command" as const, requestedAt: 4000 },
      handoff: "Fresh orientation from recent corrections.",
    };
    const summary = buildDcpNativeCompactionResult(args).summary;
    expect(summary.startsWith("<current-orientation>")).toBe(true);
    expect(summary).not.toContain(renderHeading(heading));
    h.config.nativeCompaction.maxSummaryTokens = 1;
    expect(() => buildDcpNativeCompactionResult(args)).toThrow("use host summarization");
    const handlers = new Map<string, any>();
    registerDcpNativeCompactionBridge(
      { on: (name: string, handler: any) => handlers.set(name, handler) } as any,
      h.state,
      h.config,
      async () => "fresh"
    );
    expect(
      await handlers.get("session_before_compact")(
        { branchEntries: branch, preparation: args.preparation },
        h.ctx
      )
    ).toBeUndefined();
    expect((args.preparation as any).previousSummary).toContain("fresh");
    expect((args.preparation as any).previousSummary).not.toContain(renderHeading(heading));
    expect(h.state.heading).toEqual(heading);
    expect(h.state.compressionBlocks[0].active).toBe(true);
  });

  test("context reminder never requests ongoing heading maintenance", async () => {
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
      expect(text).not.toContain("Heading revised");
      expect(text).not.toContain("No heading");
      expect(text).not.toContain("goal, now, next");
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
