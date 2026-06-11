import { describe, expect, test } from "bun:test";
import { applyPruning, makeConfig, makeState } from "../helpers/dcp-test-utils.js";
import { toolNameMatches } from "../../src/domain/pruning/index.js";
import type { DcpConfig } from "../../src/types/config.js";
import type { DcpState, ToolRecord } from "../../src/types/state.js";

function customConfig(): DcpConfig {
  const cfg = makeConfig();
  cfg.compress.protectRecentTurns = 1;
  cfg.strategies.customStrategies = {
    enabled: true,
    defaults: { minResultTokens: 300, minAgeTurns: 0 },
    rules: [{ tools: ["read", "bash", "grep"], action: "clear" }],
  };
  return cfg;
}

function recordTool(state: DcpState, callId: string, opts: Partial<ToolRecord>): void {
  state.toolCalls.set(callId, {
    toolCallId: callId,
    toolName: opts.toolName ?? "Read",
    inputArgs: opts.inputArgs ?? {},
    inputFingerprint: opts.inputFingerprint ?? `${opts.toolName ?? "Read"}::{}`,
    isError: opts.isError ?? false,
    turnIndex: opts.turnIndex ?? 0,
    timestamp: opts.timestamp ?? 1000,
    tokenEstimate: opts.tokenEstimate ?? 500,
  });
}

function padStandalone(count: number): any[] {
  const out: any[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ role: "user", content: [{ type: "text", text: `u${i}` }], timestamp: 1000 + i });
  }
  return out;
}

function toolPair(
  id: string,
  opts: {
    role?: "toolResult" | "bashExecution";
    toolName?: string;
    isError?: boolean;
    text?: string;
  } = {}
): any[] {
  const toolName = opts.toolName ?? "Read";
  return [
    {
      role: "assistant",
      content: [{ type: "toolCall", id, name: toolName, arguments: {} }],
      timestamp: 20_000,
    },
    {
      role: opts.role ?? "toolResult",
      toolCallId: id,
      toolName,
      isError: opts.isError ?? false,
      content: [{ type: "text", text: opts.text ?? "large successful output" }],
      timestamp: 20_001,
    },
  ];
}

function resultText(messages: any[], id: string): string {
  return messages.find((message: any) => message.toolCallId === id)?.content?.[0]?.text;
}

describe("custom strategy glob matcher", () => {
  test("matches exact names case-insensitively and anchors exact patterns", () => {
    expect(toolNameMatches("Read", ["read"])).toBe(true);
    expect(toolNameMatches("thread", ["read"])).toBe(false);
  });

  test("matches star globs and treats regex metacharacters literally", () => {
    expect(toolNameMatches("scan_files", ["scan_*"])).toBe(true);
    expect(toolNameMatches("scan.files", ["scan.files"])).toBe(true);
    expect(toolNameMatches("scanXfiles", ["scan.files"])).toBe(false);
  });
});

describe("customStrategies heuristic", () => {
  test("clears old large configured-tool results every cadence without pressure", () => {
    const messages = [...padStandalone(6), ...toolPair("read_old", { toolName: "Read" })];
    const state = makeState();
    recordTool(state, "read_old", { toolName: "Read", turnIndex: 0, tokenEstimate: 500 });

    applyPruning(messages, state, customConfig());

    expect(state.prunedToolIds.has("read_old")).toBe(true);
    expect(state.lastHeuristicPruneDecision?.customCandidates).toBe(1);
    expect(state.lastHeuristicPruneDecision?.committedByStrategy.custom).toBe(1);
    expect(state.lastHeuristicPruneDecision?.committedByAction.cleared).toBe(1);
  });

  test("produces nothing when disabled for replay determinism", () => {
    const messages = [...padStandalone(6), ...toolPair("read_old", { toolName: "Read" })];
    const state = makeState();
    recordTool(state, "read_old", { toolName: "Read", turnIndex: 0, tokenEstimate: 50_000 });

    const cfg = customConfig();
    cfg.strategies.customStrategies.enabled = false;
    applyPruning(messages, state, cfg);

    expect(state.prunedToolIds.has("read_old")).toBe(false);
    expect(state.lastHeuristicPruneDecision).toBeNull();
  });

  test("leaves unmatched tools untouched without a catch-all rule", () => {
    const messages = [
      ...padStandalone(6),
      ...toolPair("mcp", { toolName: "mcp__auggie__codebase" }),
    ];
    const state = makeState();
    recordTool(state, "mcp", {
      toolName: "mcp__auggie__codebase",
      turnIndex: 0,
      tokenEstimate: 50_000,
    });

    applyPruning(messages, state, customConfig());

    expect(state.prunedToolIds.has("mcp")).toBe(false);
    expect(state.lastHeuristicPruneDecision).toBeNull();
  });

  test("matches args with string and array patterns and requires all listed fields", () => {
    const messages = [
      ...padStandalone(6),
      ...toolPair("match", { toolName: "mcp_fetch" }),
      ...toolPair("missing", { toolName: "mcp_fetch" }),
      ...toolPair("non_string", { toolName: "mcp_fetch" }),
    ];
    const state = makeState();
    recordTool(state, "match", {
      toolName: "mcp_fetch",
      inputArgs: { url: "https://example.com/docs/a", mode: "raw" },
      turnIndex: 0,
      tokenEstimate: 50_000,
    });
    recordTool(state, "missing", {
      toolName: "mcp_fetch",
      inputArgs: { url: "https://example.com/docs/a" },
      turnIndex: 0,
      tokenEstimate: 50_000,
    });
    recordTool(state, "non_string", {
      toolName: "mcp_fetch",
      inputArgs: { url: "https://example.com/docs/a", mode: 123 },
      turnIndex: 0,
      tokenEstimate: 50_000,
    });

    const cfg = customConfig();
    cfg.strategies.customStrategies.rules = [
      { tools: ["mcp_*"], args: { url: ["*docs*", "*api*"], mode: "raw" }, action: "clear" },
    ];
    applyPruning(messages, state, cfg);

    expect(state.prunedToolIds.has("match")).toBe(true);
    expect(state.prunedToolIds.has("missing")).toBe(false);
    expect(state.prunedToolIds.has("non_string")).toBe(false);
  });

  test("first matching rule wins", () => {
    const messages = [
      ...padStandalone(6),
      ...toolPair("read_old", { toolName: "Read", text: "a\nb\nc\nd" }),
    ];
    const state = makeState();
    recordTool(state, "read_old", { toolName: "Read", turnIndex: 0, tokenEstimate: 50_000 });

    const cfg = customConfig();
    cfg.strategies.customStrategies.rules = [
      { tools: ["read"], action: "reduce", keep: { headLines: 1 } },
      { tools: ["read"], action: "clear" },
    ];
    const pruned = applyPruning(messages, state, cfg);

    expect(resultText(pruned, "read_old")).toBe(
      "a\n[... 3 lines removed by DCP to save context — re-run the tool if needed ...]"
    );
    expect(state.lastHeuristicPruneDecision?.committedByAction.reduced).toBe(1);
  });

  test("renders reduce with head only, tail only, and head plus tail marker counts", () => {
    const text = "l1\nl2\nl3\nl4\nl5";
    const messages = [
      ...padStandalone(6),
      ...toolPair("head", { toolName: "Read", text }),
      ...toolPair("tail", { toolName: "Bash", text }),
      ...toolPair("both", { toolName: "Grep", text }),
    ];
    const state = makeState();
    recordTool(state, "head", { toolName: "Read", turnIndex: 0, tokenEstimate: 50_000 });
    recordTool(state, "tail", { toolName: "Bash", turnIndex: 0, tokenEstimate: 50_000 });
    recordTool(state, "both", { toolName: "Grep", turnIndex: 0, tokenEstimate: 50_000 });

    const cfg = customConfig();
    cfg.strategies.customStrategies.rules = [
      { tools: ["read"], action: "reduce", keep: { headLines: 2 } },
      { tools: ["bash"], action: "reduce", keep: { tailLines: 2 } },
      { tools: ["grep"], action: "reduce", keep: { headLines: 1, tailLines: 1 } },
    ];
    const pruned = applyPruning(messages, state, cfg);

    expect(resultText(pruned, "head")).toBe(
      "l1\nl2\n[... 3 lines removed by DCP to save context — re-run the tool if needed ...]"
    );
    expect(resultText(pruned, "tail")).toBe(
      "[... 3 lines removed by DCP to save context — re-run the tool if needed ...]\nl4\nl5"
    );
    expect(resultText(pruned, "both")).toBe(
      "l1\n[... 3 lines removed by DCP to save context — re-run the tool if needed ...]\nl5"
    );
  });

  test("minAgeTurns uses cadence buckets and per-rule overrides", () => {
    const messages = [
      ...padStandalone(8),
      ...toolPair("young", { toolName: "Read" }),
      ...toolPair("old", { toolName: "Bash" }),
    ];
    const state = makeState();
    recordTool(state, "young", { toolName: "Read", turnIndex: 6, tokenEstimate: 50_000 });
    recordTool(state, "old", { toolName: "Bash", turnIndex: 6, tokenEstimate: 50_000 });

    const cfg = customConfig();
    cfg.strategies.pruneCadenceTurns = 5;
    cfg.strategies.customStrategies.defaults.minAgeTurns = 5;
    cfg.strategies.customStrategies.rules = [
      { tools: ["read"], action: "clear" },
      { tools: ["bash"], action: "clear", minAgeTurns: 1 },
    ];
    applyPruning(messages, state, cfg);

    expect(state.prunedToolIds.has("young")).toBe(false);
    expect(state.prunedToolIds.has("old")).toBe(true);
  });

  test("per-rule minResultTokens overrides defaults", () => {
    const messages = [...padStandalone(6), ...toolPair("small", { toolName: "Read" })];
    const state = makeState();
    recordTool(state, "small", { toolName: "Read", turnIndex: 0, tokenEstimate: 100 });

    const cfg = customConfig();
    cfg.strategies.customStrategies.defaults.minResultTokens = 300;
    cfg.strategies.customStrategies.rules = [
      { tools: ["read"], action: "clear", minResultTokens: 100 },
    ];
    applyPruning(messages, state, cfg);

    expect(state.prunedToolIds.has("small")).toBe(true);
  });

  test("reduce is skipped when keep covers the whole content", () => {
    const messages = [
      ...padStandalone(6),
      ...toolPair("whole", { toolName: "Read", text: "a\nb" }),
    ];
    const state = makeState();
    recordTool(state, "whole", { toolName: "Read", turnIndex: 0, tokenEstimate: 50_000 });

    const cfg = customConfig();
    cfg.strategies.customStrategies.rules = [
      { tools: ["read"], action: "reduce", keep: { headLines: 1, tailLines: 1 } },
    ];
    applyPruning(messages, state, cfg);

    expect(state.prunedToolIds.has("whole")).toBe(false);
    expect(state.lastHeuristicPruneDecision).toBeNull();
  });

  test("idempotently re-renders reduced results from the recorded action", () => {
    const messages = [
      ...padStandalone(6),
      ...toolPair("read_old", { toolName: "Read", text: "a\nb\nc\nd" }),
    ];
    const state = makeState();
    recordTool(state, "read_old", { toolName: "Read", turnIndex: 0, tokenEstimate: 50_000 });

    const cfg = customConfig();
    cfg.strategies.customStrategies.rules = [
      { tools: ["read"], action: "reduce", keep: { headLines: 1, tailLines: 1 } },
    ];
    const first = applyPruning(messages, state, cfg);
    const second = applyPruning(messages, state, cfg);

    expect(resultText(second, "read_old")).toBe(resultText(first, "read_old"));
    expect(state.prunedToolActions.get("read_old")).toEqual({
      action: "reduce",
      headLines: 1,
      tailLines: 1,
    });
  });

  test("savings gates use reduce net savings", () => {
    const messages = [
      ...padStandalone(6),
      ...toolPair("read_old", { toolName: "Read", text: "a\nb\nc\nd" }),
    ];
    const state = makeState();
    recordTool(state, "read_old", { toolName: "Read", turnIndex: 0, tokenEstimate: 50 });

    const cfg = customConfig();
    cfg.strategies.minPruneItemSavedTokens = 1_000;
    cfg.strategies.customStrategies.rules = [
      { tools: ["read"], action: "reduce", keep: { headLines: 1 }, minResultTokens: 0 },
    ];
    applyPruning(messages, state, cfg);

    expect(state.prunedToolIds.has("read_old")).toBe(false);
    expect(state.lastHeuristicPruneDecision?.customCandidates).toBe(1);
    expect(state.lastHeuristicPruneDecision?.droppedByItemGate).toBe(1);
  });

  test("handles bashExecution results in lockstep with toolResult pruning", () => {
    const messages = [
      ...padStandalone(6),
      ...toolPair("bash_old", { role: "bashExecution", toolName: "Bash" }),
    ];
    const state = makeState();
    recordTool(state, "bash_old", { toolName: "Bash", turnIndex: 0, tokenEstimate: 500 });

    const pruned = applyPruning(messages, state, customConfig());

    expect(state.prunedToolIds.has("bash_old")).toBe(true);
    expect(resultText(pruned, "bash_old")).toContain("Output removed to save context");
  });
});

describe("prunedToolIds GC", () => {
  test("drops ids absent from current result messages and retains ids still present", () => {
    const messages = [...padStandalone(2), ...toolPair("present", { toolName: "Read" })];
    const state = makeState();
    state.prunedToolIds.add("present");
    state.prunedToolActions.set("present", { action: "clear" });
    state.prunedToolIds.add("absent");
    state.prunedToolActions.set("absent", { action: "reduce", headLines: 1, tailLines: 0 });

    const pruned = applyPruning(messages, state, makeConfig());

    expect(state.prunedToolIds.has("present")).toBe(true);
    expect(state.prunedToolIds.has("absent")).toBe(false);
    expect(state.prunedToolActions.has("absent")).toBe(false);
    expect(resultText(pruned, "present")).toContain("Output removed to save context");
  });
});
