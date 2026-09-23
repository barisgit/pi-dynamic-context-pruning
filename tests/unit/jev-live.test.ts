import { describe, expect, test } from "bun:test";
import { registerContextHandler } from "../../src/application/context-handler.js";
import { JevScheduler } from "../../src/application/jev-review.js";
import { applyPruning } from "../../src/domain/pruning/index.js";
import {
  serializePersistedState,
  restorePersistedState,
} from "../../src/infrastructure/persistence.js";
import { makeConfig, makeState } from "../helpers/dcp-test-utils.js";
import type { DcpMessage } from "../../src/types/message.js";
import type { JevLedgerRecord } from "../../src/infrastructure/jev-ledger.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 15));
const response = {
  answers: {
    retention: {
      type: "choice",
      choice: "drop",
      confidence: 0.2,
      probabilities: { keep: 0.3, drop: 0.7 },
    },
  },
};

function setup() {
  const config = makeConfig();
  config.strategies.jev = { enabled: true, apply: true };
  config.strategies.deduplication.enabled = false;
  config.strategies.pruneCadenceTurns = 7;
  config.strategies.candidates.minAgeTurns = 5;
  config.strategies.candidates.minResultTokens = 1;
  config.strategies.minPruneItemSavedTokens = 1;
  config.strategies.minPruneBatchSavedTokens = 1;
  config.compress.protectRecentTurns = 1;
  const state = makeState();
  const artifact = "important old output ".repeat(300);
  const messages: DcpMessage[] = [
    { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }] },
    {
      role: "toolResult",
      toolCallId: "call",
      toolName: "read",
      content: [{ type: "text", text: artifact }],
      timestamp: 1,
    },
    ...Array.from({ length: 30 }, (_, i) => ({
      role: "user",
      content: `follow-up ${i}`,
      timestamp: i + 2,
    })),
  ];
  state.toolCalls.set("call", {
    toolCallId: "call",
    toolName: "read",
    inputArgs: {},
    inputFingerprint: "read:{}",
    isError: false,
    turnIndex: 0,
    timestamp: 1,
    tokenEstimate: 1600,
  });
  return { config, state, messages, artifact };
}

describe("live Jev", () => {
  test("accepted decision waits for a context pass, then commits through existing gates and exact recovery state", async () => {
    const f = setup();
    const rows: JevLedgerRecord[] = [];
    const scheduler = new JevScheduler({
      read: async () => [],
      append: async (_d, _s, row) => {
        rows.push(row);
      },
      request: async () => response,
    });
    applyPruning(f.messages, f.state, f.config);
    scheduler.observe(f.messages, f.state, f.config, "session");
    expect(f.state.prunedToolIds.size).toBe(0);
    await flush();
    expect(scheduler.pending("session", f.config).get("call")).toBe(f.artifact);
    f.config.strategies.minPruneBatchSavedTokens = 10000;
    applyPruning(f.messages, f.state, f.config, {
      jevDrops: scheduler.pending("session", f.config),
    });
    expect(f.state.prunedToolIds.size).toBe(0);
    expect(f.state.lastHeuristicPruneDecision?.heldByBatchGate).toBe(true);
    f.config.strategies.minPruneBatchSavedTokens = 1;
    const rendered = applyPruning(f.messages, f.state, f.config, {
      jevDrops: scheduler.pending("session", f.config),
    });
    expect(f.state.prunedToolIds.has("call")).toBe(true);
    expect(f.state.prunedToolActions.get("call")).toEqual({ action: "clear" });
    expect(f.state.pendingSave).toBe(true);
    const restored = makeState();
    restorePersistedState(serializePersistedState(f.state), restored);
    expect(restored.prunedToolIds.has("call")).toBe(true);
    expect((applyPruning(f.messages, restored, f.config)[1].content as any[])[0].text).toContain(
      "dcp_recover"
    );
    expect((rendered[1].content as any[])[0].text).toContain('dcp_recover({id:"call"})');
    expect(JSON.stringify(f.messages)).toContain(f.artifact);
    scheduler.committed("session", ["call"]);
    await flush();
    expect(rows.map((r) => r.outcome)).toEqual(["proposed", "applied"]);
  });

  test("context hook schedules asynchronously and renders the accepted drop on its next pass", async () => {
    const f = setup();
    const rows: JevLedgerRecord[] = [];
    const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
    const pi = {
      on: (name: string, handler: (event: any, ctx: any) => Promise<any>) =>
        handlers.set(name, handler),
    };
    const ctx = {
      getContextUsage: () => ({ tokens: 100, contextWindow: 100000 }),
      ui: { setStatus: () => {} },
      sessionManager: {
        getSessionId: () => "session",
        getCwd: () => process.cwd(),
        getSessionFile: () => undefined,
        getSessionDir: () => process.cwd(),
        getLeafId: () => null,
      },
    };
    registerContextHandler(pi as any, f.state, f.config, {
      read: async () => [],
      append: async (_d, _s, row) => {
        rows.push(row);
      },
      request: async () => response,
    });
    const first = await handlers.get("context")!({ messages: f.messages }, ctx);
    expect((first.messages[1].content as any[])[0].text).toContain(f.artifact);
    await flush();
    expect(rows[0]?.outcome).toBe("proposed");
    const second = await handlers.get("context")!({ messages: f.messages }, ctx);
    expect((second.messages[1].content as any[])[0].text).toContain("dcp_recover");
    expect(f.state.prunedToolIds.has("call")).toBe(true);
    await flush();
    expect(rows[1]?.outcome).toBe("applied");
  });

  test("context hook cannot apply a held old-bucket DROP when incoming messages cross cadence", async () => {
    const f = setup();
    f.config.strategies.minPruneBatchSavedTokens = 10000;
    const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
    const pi = {
      on: (name: string, handler: (event: any, ctx: any) => Promise<any>) =>
        handlers.set(name, handler),
    };
    const ctx = {
      getContextUsage: () => ({ tokens: 100, contextWindow: 100000 }),
      ui: { setStatus: () => {} },
      sessionManager: {
        getSessionId: () => "session",
        getCwd: () => process.cwd(),
        getSessionFile: () => undefined,
        getSessionDir: () => process.cwd(),
        getLeafId: () => null,
      },
    };
    registerContextHandler(pi as any, f.state, f.config, {
      read: async () => [],
      append: async () => {},
      request: async () => response,
    });
    await handlers.get("context")!({ messages: f.messages }, ctx);
    await flush();
    const held = await handlers.get("context")!({ messages: f.messages }, ctx);
    expect((held.messages[1].content as any[])[0].text).toContain(f.artifact);
    expect(f.state.lastHeuristicPruneDecision?.heldByBatchGate).toBe(true);
    const oldBucket = Math.floor(f.state.currentTurn / 7);
    f.messages.push(
      ...Array.from({ length: 4 }, (_, i) => ({ role: "user", content: `new cadence ${i}` }))
    );
    f.config.strategies.minPruneBatchSavedTokens = 1;
    const crossing = await handlers.get("context")!({ messages: f.messages }, ctx);
    expect(Math.floor(f.state.currentTurn / 7)).toBeGreaterThan(oldBucket);
    expect(f.state.prunedToolIds.has("call")).toBe(false);
    expect((crossing.messages[1].content as any[])[0].text).toContain(f.artifact);
  });

  test("live mode audits an error DROP as retained rather than an applicable proposal", async () => {
    const f = setup();
    f.state.toolCalls.get("call")!.isError = true;
    f.messages[1].isError = true;
    applyPruning(f.messages, f.state, f.config);
    const rows: JevLedgerRecord[] = [];
    const scheduler = new JevScheduler({
      read: async () => [],
      append: async (_d, _s, row) => {
        rows.push(row);
      },
      request: async () => response,
    });
    scheduler.observe(f.messages, f.state, f.config, "session");
    await flush();
    expect(rows[0]).toMatchObject({
      rawChoice: "drop",
      outcome: "gate-rejected",
      reason: "error-retained",
      mode: "apply",
    });
    expect(scheduler.pending("session", f.config).size).toBe(0);
  });

  test("newer KEEP revokes an uncommitted DROP at the next configured cadence", async () => {
    const f = setup();
    applyPruning(f.messages, f.state, f.config);
    let choice: "drop" | "keep" = "drop";
    const scheduler = new JevScheduler({
      read: async () => [],
      append: async () => {},
      request: async () => ({
        answers: {
          retention: {
            type: "choice",
            choice,
            confidence: 0.8,
            probabilities: {
              keep: choice === "keep" ? 0.8 : 0.2,
              drop: choice === "drop" ? 0.8 : 0.2,
            },
          },
        },
      }),
    });
    scheduler.observe(f.messages, f.state, f.config, "session");
    await flush();
    expect(scheduler.pending("session", f.config).has("call")).toBe(true);
    choice = "keep";
    f.state.currentTurn = Math.ceil((f.state.currentTurn + 1) / 7) * 7;
    scheduler.observe(f.messages, f.state, f.config, "session");
    await flush();
    expect(scheduler.pending("session", f.config).has("call")).toBe(false);
  });

  test("next-cadence permission is cleared before oversized review or ledger-read failure", async () => {
    const f = setup();
    f.messages[1].content = "x ".repeat(18200);
    applyPruning(f.messages, f.state, f.config);
    const rows: JevLedgerRecord[] = [];
    let failRead = false;
    let requests = 0;
    const scheduler = new JevScheduler({
      read: async () => {
        if (failRead) throw new Error("ledger unavailable");
        return [];
      },
      append: async (_d, _s, row) => {
        rows.push(row);
      },
      request: async () => {
        requests++;
        return response;
      },
    });
    scheduler.observe(f.messages, f.state, f.config, "session");
    await flush();
    expect(requests).toBe(1);
    expect(scheduler.pending("session", f.config).has("call")).toBe(true);
    f.state.currentTurn = Math.ceil((f.state.currentTurn + 1) / 7) * 7;
    f.messages.push({ role: "user", content: "A new lengthy task context ".repeat(750) });
    expect(scheduler.pending("session", f.config, f.state.currentTurn).has("call")).toBe(false);
    scheduler.observe(f.messages, f.state, f.config, "session");
    await flush();
    expect(rows.at(-1)).toMatchObject({ outcome: "skip", reason: "oversized-request" });
    expect(requests).toBe(1);
    expect(scheduler.pending("session", f.config).size).toBe(0);
    // Even failure to inspect the next cadence's ledger cannot resurrect the old grant.
    failRead = true;
    f.state.currentTurn += 7;
    scheduler.observe(f.messages, f.state, f.config, "session");
    await flush();
    expect(scheduler.pending("session", f.config).size).toBe(0);
  });

  test("a later raw DROP below P(drop) gate revokes a held accepted DROP", async () => {
    const f = setup();
    applyPruning(f.messages, f.state, f.config);
    let pDrop = 0.8;
    const rows: JevLedgerRecord[] = [];
    const scheduler = new JevScheduler({
      read: async () => [],
      append: async (_d, _s, row) => {
        rows.push(row);
      },
      request: async () => ({
        answers: {
          retention: {
            type: "choice",
            choice: "drop",
            confidence: 0.99,
            probabilities: { keep: 1 - pDrop, drop: pDrop },
          },
        },
      }),
    });
    scheduler.observe(f.messages, f.state, f.config, "session");
    await flush();
    expect(scheduler.pending("session", f.config).has("call")).toBe(true);
    pDrop = 0.59;
    f.state.currentTurn = Math.ceil((f.state.currentTurn + 1) / 7) * 7;
    scheduler.observe(f.messages, f.state, f.config, "session");
    await flush();
    expect(rows.at(-1)).toMatchObject({
      rawChoice: "drop",
      decision: "keep",
      outcome: "gate-rejected",
      reason: "low_drop_probability",
    });
    expect(scheduler.pending("session", f.config).has("call")).toBe(false);
  });

  test("a later transport failure revokes a held DROP before audit failure handling", async () => {
    const f = setup();
    applyPruning(f.messages, f.state, f.config);
    let fail = false;
    const rows: JevLedgerRecord[] = [];
    const scheduler = new JevScheduler({
      read: async () => [],
      append: async (_d, _s, row) => {
        rows.push(row);
      },
      request: async () => {
        if (fail) throw new Error("transport unavailable");
        return response;
      },
    });
    scheduler.observe(f.messages, f.state, f.config, "session");
    await flush();
    expect(scheduler.pending("session", f.config).has("call")).toBe(true);
    fail = true;
    f.state.currentTurn = Math.ceil((f.state.currentTurn + 1) / 7) * 7;
    scheduler.observe(f.messages, f.state, f.config, "session");
    await flush();
    expect(rows.at(-1)).toMatchObject({ decision: "keep", outcome: "failure" });
    expect(scheduler.pending("session", f.config).has("call")).toBe(false);
  });

  test("a later KEEP revokes a held DROP before blocked or failed audit append", async () => {
    const f = setup();
    applyPruning(f.messages, f.state, f.config);
    let choice: "drop" | "keep" = "drop";
    let release!: () => void;
    let auditStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      auditStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scheduler = new JevScheduler({
      read: async () => [],
      append: async () => {
        if (choice === "keep") {
          auditStarted();
          await blocked;
          throw new Error("ledger unavailable");
        }
      },
      request: async () => ({
        answers: {
          retention: {
            type: "choice",
            choice,
            confidence: 0.8,
            probabilities: {
              keep: choice === "keep" ? 0.8 : 0.2,
              drop: choice === "drop" ? 0.8 : 0.2,
            },
          },
        },
      }),
    });
    scheduler.observe(f.messages, f.state, f.config, "session");
    await flush();
    expect(scheduler.pending("session", f.config).has("call")).toBe(true);
    choice = "keep";
    f.state.currentTurn = Math.ceil((f.state.currentTurn + 1) / 7) * 7;
    scheduler.observe(f.messages, f.state, f.config, "session");
    await started;
    expect(scheduler.pending("session", f.config).has("call")).toBe(false);
    release();
    await flush();
    expect(scheduler.pending("session", f.config).has("call")).toBe(false);
  });

  test("exact dedup taking precedence does not claim a Jev strategy commit", async () => {
    const f = setup();
    applyPruning(f.messages, f.state, f.config);
    const rows: JevLedgerRecord[] = [];
    const scheduler = new JevScheduler({
      read: async () => [],
      append: async (_d, _s, row) => {
        rows.push(row);
      },
      request: async () => response,
    });
    scheduler.observe(f.messages, f.state, f.config, "session");
    await flush();
    f.messages.push(
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "new", name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "new",
        toolName: "read",
        content: [{ type: "text", text: f.artifact }],
      }
    );
    f.state.toolCalls.set("new", {
      ...f.state.toolCalls.get("call")!,
      toolCallId: "new",
      turnIndex: f.state.currentTurn,
    });
    f.config.strategies.deduplication.enabled = true;
    const committed: string[] = [];
    applyPruning(f.messages, f.state, f.config, {
      jevDrops: scheduler.pending("session", f.config),
      jevCommittedIds: committed,
    });
    expect(f.state.prunedToolIds.has("call")).toBe(true);
    expect(committed).toEqual([]);
    expect(f.state.lastHeuristicPruneDecision?.committedByStrategy).toMatchObject({
      dedup: 1,
      jev: 0,
    });
    scheduler.committed("session", committed);
    expect(rows).toHaveLength(1);
  });

  test("confidence-era audit rows never suppress new probability-policy review or authorize apply", async () => {
    const f = setup();
    applyPruning(f.messages, f.state, f.config);
    const rows: JevLedgerRecord[] = [
      {
        version: 1,
        kind: "jev-shadow",
        policy: "keep-drop-v1",
        sessionId: "session",
        cadence: 7,
        bucket: 28,
        cacheKey: "old",
        outcome: "proposed",
        candidateId: "call",
      },
    ];
    let calls = 0;
    const scheduler = new JevScheduler({
      read: async () => rows,
      append: async (_d, _s, row) => {
        rows.push(row);
      },
      request: async () => {
        calls++;
        return response;
      },
    });
    expect(scheduler.pending("session", f.config).size).toBe(0);
    scheduler.observe(f.messages, f.state, f.config, "session");
    await flush();
    expect(calls).toBe(1);
    expect(rows[1].policy).toBe("keep-drop-pdrop-v2");
    expect(rows[1].mode).toBe("apply");
  });

  test("stale asynchronous completion after branch reset cannot queue live work", async () => {
    const f = setup();
    applyPruning(f.messages, f.state, f.config);
    let resolve!: (value: unknown) => void;
    const scheduler = new JevScheduler({
      read: async () => [],
      append: async () => {},
      request: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    scheduler.observe(f.messages, f.state, f.config, "old-branch");
    await flush();
    scheduler.reset();
    resolve(response);
    await flush();
    expect(scheduler.pending("old-branch", f.config).size).toBe(0);
  });

  test("shadow default, changed output, errors, and session reset cannot apply queued choices", async () => {
    const f = setup();
    const scheduler = new JevScheduler({
      read: async () => [],
      append: async () => {},
      request: async () => response,
    });
    applyPruning(f.messages, f.state, f.config);
    scheduler.observe(f.messages, f.state, f.config, "session");
    await flush();
    f.config.strategies.jev = { enabled: true };
    expect(scheduler.pending("session", f.config).size).toBe(0);
    f.config.strategies.jev.apply = true;
    f.messages[1].content = "changed ".repeat(400);
    applyPruning(f.messages, f.state, f.config, {
      jevDrops: scheduler.pending("session", f.config),
    });
    expect(f.state.prunedToolIds.size).toBe(0);
    scheduler.retainEligible(f.messages, f.state, f.config);
    expect(scheduler.pending("session", f.config).size).toBe(0);
    scheduler.reset();
    expect(scheduler.pending("session", f.config).size).toBe(0);
    f.messages[1].isError = true;
    f.state.toolCalls.get("call")!.isError = true;
    applyPruning(f.messages, f.state, f.config, {
      jevDrops: new Map([["call", "changed ".repeat(400)]]),
    });
    expect(f.state.prunedToolIds.size).toBe(0);
  });
});
