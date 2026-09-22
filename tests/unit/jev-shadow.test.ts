import { describe, expect, test } from "bun:test";
import { estimateTokens } from "../../src/domain/tokens/estimate.js";
import { JevShadowScheduler } from "../../src/application/jev-shadow.js";
import {
  collectJevShadowCandidates,
  snapshotJevTaskContext,
} from "../../src/domain/pruning/jev-candidates.js";
import { makeConfig, makeState } from "../helpers/dcp-test-utils.js";
import type { DcpMessage } from "../../src/types/message.js";
import type { JevLedgerRecord } from "../../src/infrastructure/jev-ledger.js";

const flush = () => new Promise((r) => setTimeout(r, 10));
function fixture() {
  const config = makeConfig();
  config.strategies.jev = { enabled: true };
  config.strategies.pruneCadenceTurns = 7;
  config.strategies.candidates.minResultTokens = 1;
  config.strategies.candidates.minAgeTurns = 5;
  const state = makeState();
  state.currentTurn = 20;
  state.toolCalls.set("a", {
    toolCallId: "a",
    toolName: "read",
    inputArgs: { path: "source.ts" },
    inputFingerprint: "read",
    isError: false,
    turnIndex: 1,
    timestamp: 1,
    tokenEstimate: 400,
  });
  const messages: DcpMessage[] = [
    { role: "user", content: "Inspect the source, do not modify it." },
    {
      role: "toolResult",
      toolCallId: "a",
      toolName: "read",
      content: [{ type: "text", text: "source evidence ".repeat(100) }],
    },
  ];
  return { config, state, messages };
}
const response = {
  answers: {
    retention: {
      type: "choice",
      choice: "drop",
      confidence: 0.99,
      probabilities: { drop: 0.99, keep: 0.01 },
    },
  },
};

describe("Jev shadow", () => {
  test("KEEP is reevaluated next cadence, not on repeated render or resume", async () => {
    const f = fixture();
    const records: JevLedgerRecord[] = [];
    let calls = 0;
    const deps = {
      read: async () => records,
      append: async (_d: string, _s: string, row: JevLedgerRecord) => {
        records.push(row);
      },
      request: async () => {
        calls++;
        return {
          answers: {
            retention: {
              type: "choice",
              choice: "keep",
              confidence: 0.99,
              probabilities: { keep: 0.99, drop: 0.01 },
            },
          },
        };
      },
    };
    const scheduler = new JevShadowScheduler(deps);
    scheduler.observe(f.messages, f.state, f.config, "s");
    await flush();
    expect(records[0]).toMatchObject({ decision: "keep", outcome: "retained", bucket: 14 });
    scheduler.observe(f.messages, f.state, f.config, "s");
    new JevShadowScheduler(deps).observe(f.messages, f.state, f.config, "s");
    await flush();
    expect(calls).toBe(1);
    f.state.currentTurn = 21;
    scheduler.observe(f.messages, f.state, f.config, "s");
    await flush();
    expect(calls).toBe(2);
    expect(records[1].bucket).toBe(21);
  });

  test("incoming dialogue does not starve pending work or alter its immutable snapshot", async () => {
    const f = fixture();
    const records: JevLedgerRecord[] = [];
    const sent: string[] = [];
    let resolve!: (value: unknown) => void;
    const scheduler = new JevShadowScheduler({
      read: async () => [],
      append: async (_d, _s, row) => {
        records.push(row);
      },
      request: async (request) => {
        sent.push(request.state.task_context);
        return new Promise((r) => {
          resolve = r;
        });
      },
    });
    scheduler.observe(f.messages, f.state, f.config, "s");
    await flush();
    for (let turn = 21; turn <= 24; turn++) {
      f.state.currentTurn = turn;
      f.messages.push({ role: "user", content: `New correction ${turn}` });
      scheduler.observe(f.messages, f.state, f.config, "s");
    }
    resolve(response);
    await flush();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ bucket: 14, taskContext: sent[0] });
    expect(sent[0]).not.toContain("New correction");
    scheduler.observe(f.messages, f.state, f.config, "s");
    await flush();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("New correction 24");
    resolve(response);
    await flush();
    expect(records[1].bucket).toBe(21);
  });

  test("53KB and 86KB public histories remain bounded, retain newest dialogue and exclude private channels", async () => {
    for (const size of [53000, 86000]) {
      const f = fixture();
      const history: DcpMessage[] = [];
      for (let i = 0; i < Math.ceil(size / 1000); i++) {
        history.push({
          role: i % 2 ? "assistant" : "user",
          content: `entry ${i} ` + "history ".repeat(125),
        });
      }
      history.push(
        {
          role: "compactionSummary",
          summary: "Old plan: modify files",
          details: { secret: "PRIVATE_SUMMARY" },
        },
        { role: "user", content: "Newest correction: read only, do not modify." },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "PRIVATE_THINKING" },
            { type: "toolCall", name: "read", arguments: { secret: "PRIVATE_ARGS" } },
            { type: "text", text: "Newest acknowledgement: read only." },
          ],
          details: { secret: "PRIVATE_DETAILS" },
        },
        f.messages[1]
      );
      let sent = "";
      let instructions = "";
      new JevShadowScheduler({
        read: async () => [],
        append: async () => {},
        request: async (request) => {
          sent = request.state.task_context;
          instructions = request.questions.retention.instructions;
          return response;
        },
      }).observe(history, f.state, f.config, "s");
      await flush();
      expect(estimateTokens(sent)).toBeLessThan(4100);
      expect(sent).not.toContain("user: entry 0 ");
      expect(sent).toContain("user: Newest correction: read only");
      expect(sent).toContain("assistant: Newest acknowledgement: read only");
      expect(sent).toContain("Older summary: Old plan");
      expect(sent).toContain("Newer dialogue overrides older summaries");
      expect(instructions).toContain(
        "summaries are background, not authoritative current direction"
      );
      expect(sent).not.toContain("PRIVATE_");
      expect(sent).not.toContain("source evidence");
    }
  });

  test("unknown tools and eligible errors transmit complete arguments, error flag and artifact", async () => {
    for (const errorSource of ["record", "message"]) {
      const f = fixture();
      const record = f.state.toolCalls.get("a")!;
      record.toolName = "unlisted_inspector";
      record.inputArgs = { query: "exact request", nested: { limit: 17 } };
      record.isError = errorSource === "record";
      f.messages[1].isError = errorSource === "message";
      let sent: unknown;
      new JevShadowScheduler({
        read: async () => [],
        append: async () => {},
        request: async (request) => {
          sent = request.state;
          return response;
        },
      }).observe(f.messages, f.state, f.config, "s");
      await flush();
      expect(sent).toMatchObject({
        tool_name: "unlisted_inspector",
        tool_arguments: record.inputArgs,
        is_error: true,
        artifact: "source evidence ".repeat(100),
      });
    }
  });

  test("legacy ledger cannot suppress work and equal buckets from different cadences do not collide", async () => {
    const f = fixture();
    f.state.currentTurn = 28;
    const records: JevLedgerRecord[] = [];
    let calls = 0;
    const deps = {
      read: async () => records,
      append: async (_d: string, _s: string, row: JevLedgerRecord) => {
        records.push(row);
      },
      request: async () => {
        calls++;
        return response;
      },
    };
    const scheduler = new JevShadowScheduler(deps);
    scheduler.observe(f.messages, f.state, f.config, "s");
    await flush();
    const legacy: JevLedgerRecord = { ...records[0], taskContext: "LEGACY_CONTEXT" };
    delete legacy.cadence;
    delete legacy.bucket;
    delete legacy.policy;
    records.splice(0, records.length, legacy);
    new JevShadowScheduler(deps).observe(f.messages, f.state, f.config, "s");
    await flush();
    expect(calls).toBe(2);
    expect(records[1].taskContext).not.toContain("LEGACY_CONTEXT");
    f.config.strategies.pruneCadenceTurns = 14;
    scheduler.observe(f.messages, f.state, f.config, "s");
    await flush();
    expect(calls).toBe(3);
    expect(records[2]).toMatchObject({ cadence: 14, bucket: 28 });
    expect(records[2].cacheKey).not.toBe(records[1].cacheKey);
  });

  test("cadence 7 reviews all six candidates with at most four concurrent requests", async () => {
    const f = fixture();
    for (const id of ["b", "c", "d", "e", "f"]) {
      f.state.toolCalls.set(id, { ...f.state.toolCalls.get("a")!, toolCallId: id });
      f.messages.push({ ...f.messages[1], toolCallId: id });
    }
    const calls: string[] = [];
    const releases: (() => void)[] = [];
    const records: JevLedgerRecord[] = [];
    let active = 0;
    let peak = 0;
    const scheduler = new JevShadowScheduler({
      read: async () => [],
      append: async (_d, _s, row) => {
        records.push(row);
      },
      request: async (request) => {
        calls.push(request.state.candidate_id);
        peak = Math.max(peak, ++active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active--;
        return response;
      },
    });
    scheduler.observe(f.messages, f.state, f.config, "s");
    await flush();
    expect(calls).toEqual(["a", "b", "c", "d"]);
    releases.splice(0).forEach((resolve) => resolve());
    await flush();
    expect(calls).toEqual(["a", "b", "c", "d", "e", "f"]);
    releases.splice(0).forEach((resolve) => resolve());
    await flush();
    expect(peak).toBe(4);
    expect(records).toHaveLength(6);
    expect(records.every((r) => r.cadence === 7 && r.bucket === 14)).toBe(true);
    scheduler.observe(f.messages, f.state, f.config, "s");
    await flush();
    expect(calls).toHaveLength(6);
  });
  test("classifies demonstrated 33.5K code/log output intact, audits full-request token overflows", async () => {
    const f = fixture();
    let calls = 0;
    let sentArtifact = "";
    let reads = 0;
    const records: JevLedgerRecord[] = [];
    const deps = {
      read: async () => {
        reads++;
        return [];
      },
      append: async (_d: string, _s: string, row: JevLedgerRecord) => {
        records.push(row);
      },
      request: async (request: any) => {
        calls++;
        sentArtifact = request.state.artifact;
        return response;
      },
    };
    const artifact = "export const item = { id: 42, status: 'ready' }; // verification log\n"
      .repeat(600)
      .slice(0, 33548);
    f.messages[1].content = artifact;
    new JevShadowScheduler(deps).observe(f.messages, f.state, f.config, "large");
    await flush();
    expect(calls).toBe(1);
    expect(sentArtifact).toBe(artifact);
    f.messages[1].content = "x".repeat(64001);
    new JevShadowScheduler(deps).observe(f.messages, f.state, f.config, "byte-overflow");
    await flush();
    expect(calls).toBe(2);
    expect(sentArtifact).toBe("x".repeat(64001));
    // Under the former byte cap, but dense tokens plus full request metadata exceed the budget.
    f.messages[1].content = "x ".repeat(22000);
    new JevShadowScheduler(deps).observe(f.messages, f.state, f.config, "token-overflow");
    await flush();
    expect(calls).toBe(2);
    expect(reads).toBe(3);
    expect(records[2]).toMatchObject({ outcome: "skip", reason: "oversized-request" });
    expect(records[2].taskContext).toBeUndefined();
  });
  test("task context includes public host summaries but not private metadata", () => {
    expect(
      snapshotJevTaskContext([
        {
          role: "compactionSummary",
          summary: "Current restriction",
          details: { secret: "not public" },
        },
        { role: "user", content: "Next task" },
      ])
    ).toContain("Older summary: Current restriction\n\nuser: Next task");
    expect(snapshotJevTaskContext([{ role: "user", content: [{ type: "image" }] }])).toContain(
      "omitted history and nontext content may matter"
    );
  });
  test("only explicit exposed fo refs qualify; errors retain their flag, no outer containers or projection approval", () => {
    const f = fixture();
    f.state.toolCalls.get("a")!.toolName = "run";
    const candidate = {
      localId: "inner",
      compositeId: "fo-ref:v1:a:inner",
      outerToolCallId: "a",
      toolName: "read",
      input: {},
      content: [{ type: "text" as const, text: "evidence ".repeat(100) }] as [
        { type: "text"; text: string },
      ],
      isError: false,
      text: "evidence ".repeat(100),
      exposureCount: 1,
      exposureIds: ["shown"],
    };
    const bridge = {
      version: 1 as const,
      registryKey: "fo.exposed-ref-bridge.v1" as const,
      collect: () => ({
        status: "supported" as const,
        version: 1 as const,
        envelopeVersion: 1 as const,
        candidates: [candidate],
      }),
      project: () => {
        throw new Error("shadow must not project");
      },
      recover: () => undefined,
    };
    expect(collectJevShadowCandidates(f.messages, f.state, f.config)).toHaveLength(0);
    expect(
      collectJevShadowCandidates(f.messages, f.state, f.config, bridge).map((c) => c.id)
    ).toEqual([candidate.compositeId]);
    expect(collectJevShadowCandidates(f.messages, f.state, f.config, bridge)[0].ageTurns).toBe(19);
    const outerText = f.messages[1].content;
    f.messages[1].content = [
      { type: "text", text: "public envelope" },
      { type: "image", data: "image" },
    ];
    expect(collectJevShadowCandidates(f.messages, f.state, f.config, bridge)).toHaveLength(0);
    f.messages[1].content = outerText;
    candidate.exposureCount = 0;
    expect(collectJevShadowCandidates(f.messages, f.state, f.config, bridge)).toHaveLength(0);
    candidate.exposureCount = 1;
    candidate.isError = true;
    expect(collectJevShadowCandidates(f.messages, f.state, f.config, bridge)[0].isError).toBe(true);
    candidate.isError = false;
    f.state.prunedToolIds.add(candidate.compositeId);
    expect(collectJevShadowCandidates(f.messages, f.state, f.config, bridge)).toHaveLength(0);
  });
  test("malformed results retain and retry next cadence; failed ledger writes are isolated", async () => {
    const f = fixture();
    const records: JevLedgerRecord[] = [];
    let calls = 0;
    const scheduler = new JevShadowScheduler({
      read: async () => [],
      append: async (_d, _s, r) => {
        records.push(r);
      },
      request: async () => {
        calls++;
        return {};
      },
    });
    scheduler.observe(f.messages, f.state, f.config, "s");
    await flush();
    expect(records[0].outcome).toBe("failure");
    f.state.currentTurn = 21;
    scheduler.observe(f.messages, f.state, f.config, "s");
    await flush();
    expect(calls).toBe(2);
    const broken = new JevShadowScheduler({
      read: async () => [],
      append: async () => {
        throw new Error("disk failure");
      },
      request: async () => response,
    });
    expect(() => broken.observe(f.messages, f.state, f.config, "s")).not.toThrow();
    await flush();
  });
  test("disabled makes no I/O, enabled is nonblocking and never mutates transcript/state", async () => {
    const f = fixture();
    let reads = 0;
    let calls = 0;
    let resolve!: (r: unknown) => void;
    const records: JevLedgerRecord[] = [];
    const scheduler = new JevShadowScheduler({
      read: async () => {
        reads++;
        return [];
      },
      append: async (_d, _s, r) => {
        records.push(r);
      },
      request: async () => {
        calls++;
        return new Promise((r) => {
          resolve = r;
        });
      },
    });
    f.config.strategies.jev!.enabled = false;
    scheduler.observe(f.messages, f.state, f.config, "session");
    await flush();
    expect(reads).toBe(0);
    f.config.strategies.jev!.enabled = true;
    const before = structuredClone(f);
    expect(scheduler.observe(f.messages, f.state, f.config, "session")).toBeUndefined();
    await flush();
    expect(calls).toBe(1);
    expect(records).toHaveLength(0);
    scheduler.observe(f.messages, f.state, f.config, "session");
    expect(calls).toBe(1);
    resolve(response);
    await flush();
    expect(records).toHaveLength(1);
    expect(f).toEqual(before);
    expect(JSON.stringify(records)).not.toContain("source evidence");
    expect(records[0].outcome).not.toBe("applied");
    expect(records[0].rawChoice).toBe("drop");
    expect(records[0].taskContextHash).toMatch(/^[a-f0-9]{64}$/);
    expect(records[0].promptHash).toMatch(/^[a-f0-9]{64}$/);
  });
  test("ledger restart suppresses same-cadence dialogue changes but not changed output", async () => {
    const f = fixture();
    const records: JevLedgerRecord[] = [];
    let calls = 0;
    const deps = {
      read: async () => records,
      append: async (_d: string, _s: string, r: JevLedgerRecord) => {
        records.push(r);
      },
      request: async () => {
        calls++;
        return response;
      },
    };
    new JevShadowScheduler(deps).observe(f.messages, f.state, f.config, "s");
    await flush();
    expect(calls).toBe(1);
    new JevShadowScheduler(deps).observe(f.messages, f.state, f.config, "s");
    await flush();
    expect(calls).toBe(1);
    f.messages[0].content = "New instruction";
    new JevShadowScheduler(deps).observe(f.messages, f.state, f.config, "s");
    await flush();
    expect(calls).toBe(1);
    f.messages[1].content = "Changed output ".repeat(100);
    new JevShadowScheduler(deps).observe(f.messages, f.state, f.config, "s");
    await flush();
    expect(calls).toBe(2);
  });
  test("lifecycle cancellation suppresses stale audit; file failures are isolated", async () => {
    const f = fixture();
    let resolve!: (r: unknown) => void;
    let writes = 0;
    const scheduler = new JevShadowScheduler({
      read: async () => [],
      append: async () => {
        writes++;
      },
      request: () =>
        new Promise((r) => {
          resolve = r;
        }),
    });
    scheduler.observe(f.messages, f.state, f.config, "s");
    await flush();
    scheduler.reset();
    resolve(response);
    await flush();
    expect(writes).toBe(0);
    const broken = new JevShadowScheduler({
      read: async () => {
        throw new Error("file failure");
      },
      request: async () => {
        throw new Error("must not call");
      },
    });
    expect(() => broken.observe(f.messages, f.state, f.config, "s")).not.toThrow();
    await flush();
  });
  test("transport credentials and raw errors never enter the audit ledger", async () => {
    const f = fixture();
    const records: JevLedgerRecord[] = [];
    new JevShadowScheduler({
      read: async () => [],
      append: async (_d, _s, row) => {
        records.push(row);
      },
      request: async () => {
        throw new Error("Authorization: Bearer transport-only-token; raw transport detail");
      },
    }).observe(f.messages, f.state, f.config, "s");
    await flush();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      decision: "keep",
      outcome: "failure",
      reason: "request-or-audit-failed",
    });
    expect(JSON.stringify(records)).not.toContain("transport-only-token");
    expect(JSON.stringify(records)).not.toContain("raw transport detail");
  });
  test("timeout keeps one inflight request even if transport ignores cancellation", async () => {
    const f = fixture();
    let calls = 0;
    let resolve!: (r: unknown) => void;
    const records: JevLedgerRecord[] = [];
    const scheduler = new JevShadowScheduler({
      timeoutMs: 1,
      read: async () => [],
      append: async (_d, _s, r) => {
        records.push(r);
      },
      request: () => {
        calls++;
        return new Promise((r) => {
          resolve = r;
        });
      },
    });
    scheduler.observe(f.messages, f.state, f.config, "s");
    await flush();
    expect(records[0].outcome).toBe("failure");
    f.state.currentTurn = 21;
    scheduler.observe(f.messages, f.state, f.config, "s");
    await flush();
    expect(calls).toBe(1);
    resolve(response);
    await flush();
  });
  test("age/hot-tail/size/protected tools/files and nontext output fail closed", () => {
    const f = fixture();
    const collect = () => collectJevShadowCandidates(f.messages, f.state, f.config);
    expect(collect()).toHaveLength(1);
    f.config.protectedFilePatterns = ["*.ts"];
    expect(collect()).toHaveLength(0);
    f.config.protectedFilePatterns = [];
    f.config.compress.protectedTools = ["read"];
    expect(collect()).toHaveLength(0);
    f.config.compress.protectedTools = [];
    f.state.toolCalls.get("a")!.turnIndex = 19;
    expect(collect()).toHaveLength(0);
    f.state.toolCalls.get("a")!.turnIndex = 1;
    f.messages[1].content = [{ type: "image", data: "x" }] as any;
    expect(collect()).toHaveLength(0);
    f.messages[1].content = "x".repeat(64001);
    expect(collect()).toHaveLength(1);
    f.messages[1].content = "";
    expect(collect()).toHaveLength(0);
  });
  test.each(["artifact", "dialogue", "arguments", "nested-arguments", "tool-name"])(
    "%s example credentials do not block eligible public requests",
    async (location) => {
      const f = fixture();
      const example =
        'Docs: .env API_KEY=example-token Bearer example-token sk-example123 -----BEGIN PRIVATE KEY----- {"password":"example-value"}';
      if (location === "artifact") f.messages[1].content = example;
      if (location === "dialogue") f.messages[0].content = example;
      if (location === "arguments")
        f.state.toolCalls.get("a")!.inputArgs = { password: "example-value", command: example };
      if (location === "nested-arguments")
        f.state.toolCalls.get("a")!.inputArgs = { nested: { text: example } };
      if (location === "tool-name") f.state.toolCalls.get("a")!.toolName = ".env-example";
      const records: JevLedgerRecord[] = [];
      const requests: unknown[] = [];
      new JevShadowScheduler({
        read: async () => [],
        append: async (_d, _s, row) => {
          records.push(row);
        },
        request: async (request) => {
          requests.push(request);
          return response;
        },
      }).observe(f.messages, f.state, f.config, "s");
      await flush();
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(requests)).toContain(
        location === "tool-name" ? ".env-example" : "example-token"
      );
      expect(records[0]).toMatchObject({ outcome: "proposed" });
      expect(f.state.prunedToolIds.size).toBe(0);
    }
  );
  test.each(["multimodal", "protected"])("%s remains excluded", async (location) => {
    const f = fixture();
    if (location === "multimodal")
      f.messages[1].content = [
        { type: "text", text: "visible evidence ".repeat(100) },
        { type: "image", data: "private-image" },
      ];
    if (location === "protected") f.config.strategies.candidates.protectedTools = ["read"];
    const records: JevLedgerRecord[] = [];
    let calls = 0;
    new JevShadowScheduler({
      read: async () => [],
      append: async (_d, _s, row) => {
        records.push(row);
      },
      request: async () => {
        calls++;
        return response;
      },
    }).observe(f.messages, f.state, f.config, "s");
    await flush();
    expect(calls).toBe(0);
    expect(records[0]).toMatchObject({ outcome: "skip", reason: "no-eligible-candidates" });
    expect(JSON.stringify(records)).not.toContain("private-image");
  });
  test("lifecycle reset preserves occupied worker slots until old transports settle", async () => {
    const f = fixture();
    for (const id of ["b", "c", "d", "e", "f"]) {
      f.state.toolCalls.set(id, { ...f.state.toolCalls.get("a")!, toolCallId: id });
      f.messages.push({ ...f.messages[1], toolCallId: id });
    }
    const pending: Array<(value: unknown) => void> = [];
    const records: JevLedgerRecord[] = [];
    let calls = 0;
    const scheduler = new JevShadowScheduler({
      read: async () => [],
      append: async (_d, _s, row) => {
        records.push(row);
      },
      request: () => {
        calls++;
        return new Promise((resolve) => pending.push(resolve));
      },
    });
    scheduler.observe(f.messages, f.state, f.config, "old");
    await flush();
    expect(calls).toBe(4);
    scheduler.reset();
    scheduler.observe(f.messages, f.state, f.config, "new");
    await flush();
    expect(calls).toBe(4);
    pending.splice(0).forEach((resolve) => resolve(response));
    await flush();
    expect(records).toHaveLength(0);
    scheduler.observe(f.messages, f.state, f.config, "new");
    await flush();
    expect(calls).toBe(8);
    pending.splice(0).forEach((resolve) => resolve(response));
    await flush();
    pending.splice(0).forEach((resolve) => resolve(response));
    await flush();
    expect(records).toHaveLength(6);
    expect(records.every((row) => row.sessionId === "new")).toBe(true);
  });
  test("age is captured from logical turns before async work and audited exactly as sent", async () => {
    const f = fixture();
    f.config.strategies.pruneCadenceTurns = 25;
    f.state.currentTurn = 50;
    f.state.toolCalls.get("a")!.turnIndex = 7;
    let release!: (rows: JevLedgerRecord[]) => void;
    const rows: JevLedgerRecord[] = [];
    const ages: Array<number | null> = [];
    const scheduler = new JevShadowScheduler({
      read: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      append: async (_d, _s, row) => {
        rows.push(row);
      },
      request: async (request) => {
        ages.push(request.state.age_turns);
        return response;
      },
    });
    scheduler.observe(f.messages, f.state, f.config, "age");
    f.state.currentTurn = 60;
    f.state.toolCalls.get("a")!.turnIndex = 9;
    release([]);
    await flush();
    expect(ages).toEqual([43]);
    expect(rows[0].age_turns).toBe(43);
    scheduler.observe(f.messages, f.state, f.config, "age");
    await flush();
    expect(ages).toEqual([43]);
    f.state.currentTurn = 75;
    scheduler.observe(f.messages, f.state, f.config, "age");
    release(rows);
    await flush();
    expect(ages).toEqual([43, 66]);
    expect(rows[1].age_turns).toBe(66);
  });
});
