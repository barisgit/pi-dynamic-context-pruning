import { describe, expect, test } from "bun:test";
import { REMINDER_UPSERT_EVENT } from "pi-extension-utils/pi";
import { renderHeading, renderHeadingMessage } from "../../src/domain/compression/heading.ts";
import {
  buildSourceItemKey,
  buildTranscriptSnapshot,
  countLogicalTurns,
  INTERNAL_HEADING,
} from "../../src/domain/transcript/index.ts";
import { applyPruning, injectMessageIds } from "../../src/domain/pruning/index.ts";
import { registerCompressTool } from "../../src/application/compress-tool/registration.ts";
import { registerContextHandler } from "../../src/application/context-handler.ts";
import {
  serializePersistedState,
  restorePersistedState,
} from "../../src/infrastructure/persistence.ts";
import { replayDcpState } from "../../src/domain/replay/index.ts";
import { resetState } from "../../src/state.ts";
import {
  makeConfig,
  makeState,
  buildCompressionArtifactsForRange,
} from "../helpers/dcp-test-utils.ts";

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
