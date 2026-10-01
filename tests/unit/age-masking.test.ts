import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyPruning, makeConfig, makeState } from "../helpers/dcp-test-utils.js";
import { hydrateMissingToolRecords } from "../../src/application/tool-recording.js";
import { recoverOriginalToolOutput } from "../../src/application/recover-tool.js";
import {
  serializePersistedState,
  restorePersistedState,
} from "../../src/infrastructure/persistence.js";
import { estimateTokens } from "../../src/domain/tokens/estimate.js";
import type { DcpMessage } from "../../src/types/message.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Distinct lines so the real tokenizer counts roughly five tokens per line. */
function output(label: string, lines: number): string {
  return Array.from({ length: lines }, (_, i) => `${label} line ${i} observed`).join("\n");
}

function call(
  id: string,
  name: string,
  args: Record<string, unknown>,
  text: string,
  extra: Partial<DcpMessage> = {}
): DcpMessage[] {
  return [
    { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
    {
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      content: [{ type: "text", text }],
      isError: false,
      ...extra,
    },
  ];
}

function users(count: number, from = 0): DcpMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: "user",
    content: `follow-up ${from + i}`,
  }));
}

function stamp(messages: DcpMessage[]): DcpMessage[] {
  messages.forEach((message, index) => {
    message.timestamp = 1_000 + index;
  });
  return messages;
}

/** User-shaped gates: age 25, item 100, batch 10K, cadence 5. */
function ageConfig(enabled = true) {
  const config = makeConfig();
  config.strategies.ageMasking = { enabled };
  config.strategies.deduplication.enabled = false;
  config.strategies.pruneCadenceTurns = 5;
  config.strategies.candidates.minAgeTurns = 25;
  config.strategies.minPruneItemSavedTokens = 100;
  config.strategies.minPruneBatchSavedTokens = 10_000;
  return config;
}

function textOf(messages: DcpMessage[], id: string): string {
  const message = messages.find((m) => m.toolCallId === id);
  return (message?.content as any[])[0].text;
}

const marker = (id: string) =>
  `[Output removed by DCP; original retained: dcp_recover({id:${JSON.stringify(id)}})]`;

// ---------------------------------------------------------------------------
// Ordinary tool results
// ---------------------------------------------------------------------------

describe("age-based tool-output masking", () => {
  test("holds old output below the batch gate and masks once old output accumulates", () => {
    const first = output("first", 1_300);
    const second = output("second", 1_300);
    expect(estimateTokens(first)).toBeLessThan(10_000);
    expect(estimateTokens(first) + estimateTokens(second)).toBeGreaterThan(10_000);
    const config = ageConfig();
    const state = makeState();

    const early = stamp([...call("first", "read", { path: "a.ts" }, first), ...users(35)]);
    hydrateMissingToolRecords(early, state);
    const held = applyPruning(early, state, config);
    expect(state.prunedToolIds.size).toBe(0);
    expect(state.lastHeuristicPruneDecision?.heldByBatchGate).toBe(true);
    expect(textOf(held, "first")).toBe(first);

    const later = stamp([
      ...call("first", "read", { path: "a.ts" }, first),
      ...users(35),
      ...call("second", "bash", { command: "make test" }, second),
      ...users(35, 35),
    ]);
    hydrateMissingToolRecords(later, state);
    const rendered = applyPruning(later, state, config);
    expect([...state.prunedToolIds].sort()).toEqual(["first", "second"]);
    expect(state.lastHeuristicPruneDecision?.committedByStrategy.age).toBe(2);
    expect(state.lastHeuristicPruneDecision?.batchSavedTokens).toBeGreaterThanOrEqual(10_000);
    expect(textOf(rendered, "first")).toBe(marker("first"));
    expect(textOf(rendered, "second")).toBe(marker("second"));
  });

  test("is off by default and keeps young and hot-tail output", () => {
    const old = output("old", 2_500);
    const young = output("young", 2_500);
    const tail = output("tail", 2_500);
    const messages = stamp([
      ...call("old", "read", { path: "old.ts" }, old),
      ...users(30),
      ...call("young", "read", { path: "young.ts" }, young),
      ...users(10),
      ...call("tail", "read", { path: "tail.ts" }, tail),
    ]);

    const offState = makeState();
    hydrateMissingToolRecords(messages, offState);
    const offConfig = ageConfig(false);
    delete (offConfig.strategies as any).ageMasking;
    applyPruning(messages, offState, offConfig);
    expect(offState.prunedToolIds.size).toBe(0);

    const state = makeState();
    hydrateMissingToolRecords(messages, state);
    const config = ageConfig();
    config.strategies.minPruneBatchSavedTokens = 0;
    const rendered = applyPruning(messages, state, config);
    expect([...state.prunedToolIds]).toEqual(["old"]);
    expect(textOf(rendered, "young")).toBe(young);
    expect(textOf(rendered, "tail")).toBe(tail);
  });

  test("always keeps errors, images, mutations, DCP tools, containers and instruction files", () => {
    const big = (label: string) => output(label, 2_500);
    const kept: [string, string, Record<string, unknown>, Partial<DcpMessage>?][] = [
      ["err", "bash", { command: "false" }, { isError: true }],
      ["edit", "edit", { path: "a.ts" }],
      ["write", "write", { path: "b.ts" }],
      ["patch", "apply_patch", { patch: "diff" }],
      ["compress", "compress", { ranges: [] }],
      ["recover", "dcp_recover", { id: "x" }],
      ["agent", "subagent", { task: "look" }],
      ["agents-md", "read", { path: "AGENTS.md" }],
      ["claude-md", "read", { path: "/repo/docs/CLAUDE.md" }],
      ["skill-md", "read", { path: "/skills/x/SKILL.md" }],
    ];
    const messages = stamp([
      ...kept.flatMap(([id, name, args, extra]) => call(id, name, args, big(id), extra)),
      ...call("image", "read", { path: "shot.png" }, big("image"), {
        content: [
          { type: "text", text: big("image") },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
      }),
      ...call("plain", "read", { path: "src/plain.ts" }, big("plain")),
      ...users(40),
    ]);
    const state = makeState();
    hydrateMissingToolRecords(messages, state);
    const rendered = applyPruning(messages, state, ageConfig());
    expect([...state.prunedToolIds]).toEqual(["plain"]);
    for (const [id] of kept) expect(textOf(rendered, id)).toBe(big(id));
    expect(textOf(rendered, "image")).toBe(big("image"));
  });

  test("masked output recovers exactly and stays masked across restore", () => {
    const original = output("recoverable", 2_500);
    const messages = stamp([...call("call", "read", { path: "src/x.ts" }, original), ...users(40)]);
    const state = makeState();
    hydrateMissingToolRecords(messages, state);
    const rendered = applyPruning(messages, state, ageConfig());
    expect(textOf(rendered, "call")).toBe(marker("call"));
    expect(state.pendingSave).toBe(true);

    const entries = messages.map((message) => ({ type: "message", message }));
    expect(recoverOriginalToolOutput(entries, "call").content).toEqual([
      { type: "text", text: original },
    ]);

    // A persisted selection keeps rendering even if the flag is later turned off.
    const resumed = makeState();
    restorePersistedState(serializePersistedState(state), resumed);
    hydrateMissingToolRecords(messages, resumed);
    expect(textOf(applyPruning(messages, resumed, ageConfig(false)), "call")).toBe(marker("call"));
  });
});

// ---------------------------------------------------------------------------
// Exposed fo Refs (real fo bridge when the sibling repository is present)
// ---------------------------------------------------------------------------

const foRuntime = "../../../../fo-coding-agent/src/runtime/";
const exposedRefsUrl = new URL(`${foRuntime}exposed-refs.ts`, import.meta.url);
const realFoTest = test.skipIf(!existsSync(fileURLToPath(exposedRefsUrl)));

async function loadRealFo() {
  const [{ foExposedRefBridgeV1 }, { makeRef }, { projectModelText }] = await Promise.all([
    import(exposedRefsUrl.href),
    import(new URL(`${foRuntime}refs.ts`, import.meta.url).href),
    import(new URL(`${foRuntime}envelope.ts`, import.meta.url).href),
  ]);
  return { bridge: foExposedRefBridgeV1, makeRef, projectModelText };
}

describe("age-based masking of exposed fo Refs", () => {
  realFoTest("masks an old exposed Ref but keeps out() text and a SKILL.md Ref", async () => {
    const { bridge, makeRef, projectModelText } = await loadRealFo();
    const original = output("ref-body", 2_500);
    const skill = output("skill-body", 400);
    const body = makeRef("read", original, { cwd: "/repo", input: "big.txt", timelineId: "t-big" });
    const skillRef = makeRef("read", skill, {
      cwd: "/repo",
      input: "/skills/x/SKILL.md",
      timelineId: "t-skill",
    });
    const timelineEntry = (id: string, path: string, text: string) => ({
      id,
      kind: "tool",
      toolName: "read",
      args: { path },
      result: { content: [{ type: "text", text }], isError: false },
    });
    const envelope: any = {
      kind: "sandbox.result",
      version: 1,
      script: { hash: "age" },
      emissions: [
        { kind: "text", text: "AUTHORED-OUT-TEXT" },
        { kind: "ref", label: "big", ref: body },
        { kind: "ref", label: "skill", ref: skillRef },
      ],
      final: "KEEP-FINAL",
      timeline: [
        timelineEntry("t-big", "big.txt", original),
        timelineEntry("t-skill", "/skills/x/SKILL.md", skill),
      ],
      trace: [],
      budgets: { timedOut: false, calls: 2, visibleBytesTruncated: false },
    };
    const outerText = projectModelText(envelope, 1_000_000, 1_000_000).text;
    const messages = stamp([
      ...call("outer-run", "run", { code: "fixture" }, outerText, { details: envelope }),
      ...users(40),
    ]);
    const collected = bridge.collect({ outerToolCallId: "outer-run", details: envelope });
    if (collected.status !== "supported") throw new Error("expected supported bridge");
    const bigId = collected.candidates.find((c: any) => c.timelineId === "t-big").compositeId;
    const skillId = collected.candidates.find((c: any) => c.timelineId === "t-skill").compositeId;

    const config = ageConfig();
    const state = makeState();
    hydrateMissingToolRecords(messages, state);
    const text = textOf(
      applyPruning(messages, state, config, { foRefBridge: bridge }),
      "outer-run"
    );
    expect([...state.prunedToolIds]).toEqual([bigId]);
    expect(text).toContain(marker(bigId));
    expect(text).not.toContain("ref-body line 100 observed");
    expect(text).toContain("AUTHORED-OUT-TEXT");
    expect(text).toContain("KEEP-FINAL");
    expect(text).toContain("skill-body line 100 observed");
    expect(state.prunedToolIds.has(skillId)).toBe(false);

    const resumed = makeState();
    restorePersistedState(serializePersistedState(state), resumed);
    hydrateMissingToolRecords(messages, resumed);
    expect(
      textOf(applyPruning(messages, resumed, config, { foRefBridge: bridge }), "outer-run")
    ).toContain(marker(bigId));
    const entries = messages.map((message) => ({ type: "message", message }));
    expect(recoverOriginalToolOutput(entries, bigId, bridge).details.originalRef).toMatchObject({
      value: original,
    });
  });
});
