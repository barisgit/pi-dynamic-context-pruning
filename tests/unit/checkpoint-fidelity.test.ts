import { describe, expect, test } from "bun:test";
import { projectCheckpointMessage } from "../../src/application/checkpoint-content.js";
import { createCheckpointHandoffGenerator } from "../../src/application/checkpoint-handoff.js";
import {
  buildDcpNativeCompactionResult,
  registerDcpNativeCompactionBridge,
  triggerDcpNativeCompaction,
} from "../../src/application/native-compaction.js";
import { renderCompressedBlockText } from "../../src/domain/compression/materialize.js";
import {
  buildCompressionArtifactsForRange,
  makeConfig,
  makeState,
} from "../helpers/dcp-test-utils.js";

const restriction = "Do not send real emails without my explicit approval.";
const correction = "Correction: draft only; no publishing. Next inspect the draft.";
const user = (text: string, timestamp: number) => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp,
});

function fixture() {
  const messages = [
    user("Setup", 1000),
    user("long history ".repeat(100) + restriction, 2000),
    user("UI status", 3000),
    user(correction, 4000),
  ];
  const entries = messages.map((message, i) => ({
    type: "message" as const,
    id: `e${i}`,
    parentId: i ? `e${i - 1}` : null,
    timestamp: new Date(message.timestamp).toISOString(),
    message,
  }));
  const blocks = [0, 2].map((index, i) => ({
    id: i + 1,
    topic: "Phase",
    summary: messages[index].content[0].text,
    startTimestamp: messages[index].timestamp,
    endTimestamp: messages[index].timestamp,
    anchorTimestamp: messages[index].timestamp + 1,
    active: true,
    summaryTokenEstimate: 10,
    createdAt: 10 + i,
    metadata: buildCompressionArtifactsForRange(
      messages,
      makeState(),
      messages[index].timestamp,
      messages[index].timestamp
    ).metadata,
  }));
  return { messages, entries, state: makeState(blocks), config: makeConfig() };
}

const request = { id: "checkpoint", reason: "host" as const, requestedAt: 1 };

function hookContext() {
  return {
    hasUI: false,
    sessionManager: {
      getSessionId: () => "test",
      getCwd: () => "/tmp",
      getSessionDir: () => "/tmp",
      getSessionFile: () => undefined,
      getLeafId: () => "leaf",
    },
  };
}

function register(state: any, config: any, handoff: any) {
  const handlers = new Map<string, any>();
  registerDcpNativeCompactionBridge(
    { on: (name: string, fn: any) => handlers.set(name, fn) } as any,
    state,
    config,
    handoff
  );
  return handlers.get("session_before_compact");
}

describe("checkpoint fidelity", () => {
  test("seeded host fallback commits retirement and auto continuation without reviving discarded blocks", async () => {
    const f = fixture();
    f.config.nativeCompaction.minHiddenCoverageRatio = 1;
    f.state.lastCompressTurn = 80;
    const summaries = f.state.compressionBlocks.map((block) => block.summary);
    const handlers = new Map<string, any>();
    const sent: string[] = [];
    const pi = {
      on: (name: string, fn: any) => handlers.set(name, fn),
      appendEntry() {},
      sendUserMessage: (text: string) => sent.push(text),
    };
    registerDcpNativeCompactionBridge(
      pi as any,
      f.state,
      f.config,
      async () => "Only drafts; no send permission."
    );
    const ctx = { ...hookContext(), compact() {} };
    void triggerDcpNativeCompaction(ctx as any, f.state, "auto");
    const event = {
      branchEntries: f.entries,
      preparation: {
        firstKeptEntryId: "e2",
        tokensBefore: 1000,
        previousSummary: "obsolete checkpoint",
      },
    };
    expect(await handlers.get("session_before_compact")(event, ctx)).toBeUndefined();
    expect(event.preparation.previousSummary).toContain("Only drafts; no send permission.");
    expect(event.preparation.previousSummary).not.toContain("obsolete checkpoint");
    expect(f.state.compressionBlocks.every((block) => block.active)).toBe(true);
    await handlers.get("session_compact")(
      {
        compactionEntry: { firstKeptEntryId: "e2", details: { readFiles: [], modifiedFiles: [] } },
      },
      ctx
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.state.compressionBlocks.map((block) => block.active)).toEqual([false, true]);
    expect(f.state.compressionBlocks.map((block) => block.summary)).toEqual(summaries);
    expect(f.state.lastCompressTurn).toBe(-1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("[dcp-auto-compaction]");
  });

  test.each(["native", "host", "oversized"])(
    "%s commit retires only records actually supplied",
    async (path) => {
      const f = fixture();
      f.config.compress.renderFullBlockCount = 1;
      f.config.compress.renderCompactBlockCount = 0;
      f.config.nativeCompaction.minHiddenCoverageRatio = path === "native" ? 0.3 : 1;
      if (path === "oversized") f.config.nativeCompaction.maxSummaryTokens = 1;
      f.state.compressionBlocks.forEach((b) => {
        b.savedTokenEstimate = 10;
      });
      const handlers = new Map<string, any>();
      registerDcpNativeCompactionBridge(
        { on: (name: string, fn: any) => handlers.set(name, fn), appendEntry() {} } as any,
        f.state,
        f.config,
        async () => "Fresh direction."
      );
      const event = {
        branchEntries: f.entries,
        preparation: { firstKeptEntryId: "e3", tokensBefore: 1000, previousSummary: "old" },
      };
      const ctx = hookContext();
      const override = await handlers.get("session_before_compact")(event, ctx);
      if (path === "host") {
        expect(event.preparation.previousSummary).toContain("UI status");
        expect(event.preparation.previousSummary).not.toContain("Setup");
      }
      await handlers.get("session_compact")(
        {
          compactionEntry: override?.compaction ?? {
            firstKeptEntryId: "e3",
            details: { readFiles: [], modifiedFiles: [] },
          },
        },
        ctx
      );
      expect(f.state.compressionBlocks.map((b) => b.active)).toEqual(
        path === "oversized" ? [true, true] : [true, false]
      );
      expect(f.state.lifetimeTokensSavedRealized).toBe(path === "oversized" ? 0 : 10);
    }
  );

  test("same-timestamp exact coverage remains conservative and selects seeded host fallback", async () => {
    const f = fixture();
    f.entries[1].message.timestamp = 1000;
    f.entries[1].timestamp = new Date(1000).toISOString();
    f.config.nativeCompaction.minHiddenCoverageRatio = 1;

    for (const exact of [false, true]) {
      const block = {
        ...f.state.compressionBlocks[0],
        metadata: exact ? f.state.compressionBlocks[0].metadata : undefined,
      };
      const before = register(
        makeState([block]),
        f.config,
        async () => `Fresh: ${restriction} ${correction}`
      );
      const event: any = {
        branchEntries: f.entries,
        preparation: {
          firstKeptEntryId: "e2",
          tokensBefore: 1000,
          previousSummary: "STALE PRIOR SUMMARY",
        },
        customInstructions: "HOST CUSTOM INSTRUCTIONS",
      };

      expect(await before(event, { hasUI: false })).toBeUndefined();
      expect(event.preparation.firstKeptEntryId).toBe("e2");
      expect(event.preparation.previousSummary).toContain(restriction);
      expect(event.preparation.previousSummary).toContain(correction);
      expect(event.preparation.previousSummary).not.toContain("STALE PRIOR SUMMARY");
      expect(event.customInstructions).toBe("HOST CUSTOM INSTRUCTIONS");
    }
  });

  test("native hook uses a fresh tail-informed restriction and correction without raw-gap serialization", async () => {
    const f = fixture();
    const before = register(
      f.state,
      f.config,
      async () => `Fresh authorized state: ${restriction} ${correction}`
    );
    const result = await before(
      {
        branchEntries: f.entries,
        preparation: {
          firstKeptEntryId: "e3",
          tokensBefore: 1000,
          previousSummary: "OLD CHECKPOINT SHOULD NOT RECURSE",
        },
      },
      hookContext()
    );

    expect(result.compaction.firstKeptEntryId).toBe("e3");
    expect(result.compaction.summary).toContain(restriction);
    expect(result.compaction.summary).toContain(correction);
    expect(result.compaction.summary).not.toContain("OLD CHECKPOINT SHOULD NOT RECURSE");
    expect(result.compaction.summary).not.toContain("long history long history");
    expect(result.compaction.details.renderedUncoveredExcerptCount).toBe(0);
    expect(result.compaction.details.uncoveredHiddenMessageCount).toBe(1);
  });

  test.each(["tier", "budget"])(
    "coverage ignores summaries omitted by %s admission",
    async (limit) => {
      const f = fixture();
      f.config.nativeCompaction.minHiddenCoverageRatio = 0.5;
      if (limit === "tier") {
        f.config.compress.renderFullBlockCount = 1;
        f.config.compress.renderCompactBlockCount = 0;
      } else {
        f.config.nativeCompaction.maxSummaryTokens = 50;
        f.state.compressionBlocks[1].summary = "Huge retained record. ".repeat(1000);
      }
      const before = register(f.state, f.config, async () => "Draft only.");
      const event = {
        branchEntries: f.entries,
        preparation: { firstKeptEntryId: "e3", tokensBefore: 1000, previousSummary: "old" },
      };
      // All active exact keys cover 2/3, but final records cover only 1/3 or 0.
      expect(await before(event, hookContext())).toBeUndefined();
      expect(event.preparation.firstKeptEntryId).toBe("e3");
      expect(event.preparation.previousSummary).toContain("Draft only.");
    }
  );

  test("previous checkpoint text is not appended or duplicated", () => {
    const f = fixture();
    const historical = "HISTORICAL_CHECKPOINT_UNIQUE";
    const fresh = `Fresh direction: ${restriction}`;
    const result = buildDcpNativeCompactionResult({
      ...f,
      branchEntries: f.entries as any,
      preparation: {
        firstKeptEntryId: "e3",
        tokensBefore: 1000,
        previousSummary: `${historical} ${historical}`,
      },
      request,
      handoff: fresh,
    });

    expect(result.summary).toContain(fresh);
    expect(result.summary).not.toContain(historical);
    expect(result.summary.split(fresh)).toHaveLength(2);
  });

  test("six appended bounded host-fallback cycles replace prior memory with fresh direction", async () => {
    const state = makeState();
    const config = makeConfig();
    config.nativeCompaction.minHiddenCoverageRatio = 1;
    config.nativeCompaction.maxSummaryTokens = 40;
    const entries: any[] = [];
    let cycle = 0;
    const before = register(
      state,
      config,
      async () => `FRESH_DIRECTION_${cycle}: draft only; inspect correction ${cycle}.`
    );

    for (cycle = 0; cycle < 6; cycle++) {
      const hidden = user(`completed work ${cycle}`, 1000 + cycle * 3);
      const hiddenId = `h${cycle}`;
      entries.push({
        type: "message",
        id: hiddenId,
        parentId: entries.at(-1)?.id ?? null,
        timestamp: new Date(hidden.timestamp).toISOString(),
        message: hidden,
      });
      const message = user(`new work ${cycle}`, hidden.timestamp + 1);
      const id = `m${cycle}`;
      entries.push({
        type: "message",
        id,
        parentId: hiddenId,
        timestamp: new Date(message.timestamp).toISOString(),
        message,
      });
      const event: any = {
        branchEntries: entries,
        preparation: {
          firstKeptEntryId: id,
          tokensBefore: 100,
          previousSummary: cycle ? `FRESH_DIRECTION_${cycle - 1}` : "initial stale summary",
        },
      };

      expect(await before(event, { hasUI: false })).toBeUndefined();
      expect(event.preparation.previousSummary).toContain(`FRESH_DIRECTION_${cycle}`);
      if (cycle > 0)
        expect(event.preparation.previousSummary).not.toContain(`FRESH_DIRECTION_${cycle - 1}`);
      entries.push({
        type: "compaction",
        id: `c${cycle}`,
        parentId: id,
        timestamp: new Date(message.timestamp + 1).toISOString(),
        summary: event.preparation.previousSummary,
        firstKeptEntryId: id,
      });
    }
  });

  test("public projection retains shell status and tool arguments, not private metadata", () => {
    const shell = projectCheckpointMessage({
      role: "bashExecution",
      command: "check",
      output: "PUBLIC_STDERR",
      exitCode: 2,
      cancelled: false,
      details: { secret: "PRIVATE" },
    });
    expect(shell).toEqual({
      role: "bashExecution",
      command: "check",
      output: "PUBLIC_STDERR",
      exitCode: 2,
      cancelled: false,
    });
    expect(
      projectCheckpointMessage({
        role: "bashExecution",
        excludeFromContext: true,
        output: "not model-visible",
      })
    ).toBeNull();
    const assistant = projectCheckpointMessage({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call",
          name: "read",
          arguments: { path: "PUBLIC_PATH" },
          privateSignature: "PRIVATE",
        },
      ],
    });
    expect(JSON.stringify(assistant)).toContain("PUBLIC_PATH");
    expect(JSON.stringify(assistant)).not.toContain("PRIVATE");
    expect(() =>
      projectCheckpointMessage({
        role: "user",
        content: [{ type: "new-unknown-part", data: "not safe to guess" }],
      })
    ).toThrow("Unsupported checkpoint content");
  });

  test("fresh orientation excludes canonical details from visible tool projection", async () => {
    const f = fixture();
    const entries: any[] = [
      ...f.entries,
      {
        type: "message",
        id: "e4",
        parentId: "e3",
        timestamp: new Date(5000).toISOString(),
        message: {
          role: "assistant",
          timestamp: 5000,
          content: [{ type: "toolCall", id: "outer-run", name: "run", arguments: {} }],
        },
      },
      {
        type: "message",
        id: "e5",
        parentId: "e4",
        timestamp: new Date(6000).toISOString(),
        message: {
          role: "toolResult",
          toolName: "run",
          toolCallId: "outer-run",
          isError: false,
          timestamp: 6000,
          content: [{ type: "text", text: "EXPOSED_PUBLIC_RESULT" }],
          details: { hidden: "PRIVATE_HANDOFF_SECRET" },
        },
      },
    ];
    const generator = createCheckpointHandoffGenerator();
    await generator(
      { branchEntries: entries } as any,
      {
        model: {},
        modelRegistry: {
          complete: async (_model: any, context: any) => {
            const text = context.messages[0].content[0].text;
            expect(text).toContain("EXPOSED_PUBLIC_RESULT");
            expect(text).not.toContain("PRIVATE_HANDOFF_SECRET");
            return {
              stopReason: "stop",
              content: [{ type: "text", text: "Fresh orientation." }],
            };
          },
        },
      } as any,
      f.state,
      f.config
    );
  });

  test("handoff passes image input to the working model while native output does not raw-preserve it", async () => {
    const f = fixture();
    (f.entries[3].message.content as any[]).push({
      type: "image",
      data: "AAAA",
      mimeType: "image/png",
    });
    const generator = createCheckpointHandoffGenerator();
    await generator(
      { branchEntries: f.entries } as any,
      {
        model: {},
        modelRegistry: {
          complete: async (_model: any, context: any) => {
            expect(context.messages[0].content).toContainEqual({
              type: "image",
              data: "AAAA",
              mimeType: "image/png",
            });
            return {
              stopReason: "stop",
              content: [{ type: "text", text: "Fresh image-aware direction." }],
            };
          },
        },
      } as any,
      f.state,
      f.config
    );

    expect(() =>
      buildDcpNativeCompactionResult({
        ...f,
        branchEntries: f.entries as any,
        preparation: { firstKeptEntryId: "e3", tokensBefore: 1000 },
        request,
        handoff: "Fresh image-aware direction.",
      })
    ).not.toThrow();
  });

  test("authored restrictions past 640 characters survive every block detail tier", () => {
    const summary = "Implementation details. ".repeat(100) + restriction;
    for (const detailLevel of ["full", "compact", "minimal"] as const) {
      expect(renderCompressedBlockText({ id: 1, topic: "mail", summary, detailLevel })).toContain(
        summary
      );
    }
  });

  test("dedicated completion sees current effective records and latest tail without changing live state", async () => {
    const f = fixture();
    f.state.lastRenderedMessages = [user("Stale cached prefix", 1)];
    const before = structuredClone(f.state);
    const model = { id: "working-model", provider: "fake" };
    const signal = new AbortController().signal;
    const generator = createCheckpointHandoffGenerator((async (
      chosen: any,
      context: any,
      options: any
    ) => {
      expect(chosen).toBe(model);
      const text = context.messages[0].content[0].text;
      expect(text).toContain("Setup");
      expect(text).toContain(correction);
      expect(text).not.toContain("Stale cached prefix");
      expect(context.tools).toBeUndefined();
      expect(options.signal).toBe(signal);
      return {
        stopReason: "stop",
        content: [{ type: "text", text: "Draft only. Inspect draft next." }],
      };
    }) as any);
    expect(
      await generator(
        { branchEntries: f.entries, signal } as any,
        {
          model,
          modelRegistry: {},
        } as any,
        f.state,
        f.config
      )
    ).toBe("Draft only. Inspect draft next.");
    expect(f.state).toEqual(before);
  });

  test("current host registry completion receives long recent tool evidence without clipping", async () => {
    const f = fixture();
    const entries: any[] = [
      ...f.entries,
      {
        type: "message",
        id: "e4",
        parentId: "e3",
        timestamp: new Date(5000).toISOString(),
        message: {
          role: "assistant",
          timestamp: 5000,
          content: [
            { type: "toolCall", id: "read1", name: "read", arguments: { path: "policy.txt" } },
          ],
        },
      },
      {
        type: "message",
        id: "e5",
        parentId: "e4",
        timestamp: new Date(6000).toISOString(),
        message: {
          role: "toolResult",
          timestamp: 6000,
          toolCallId: "read1",
          toolName: "read",
          isError: false,
          content: [{ type: "text", text: "Tool evidence. ".repeat(400) + restriction }],
        },
      },
    ];
    const generator = createCheckpointHandoffGenerator();
    let calls = 0;
    expect(
      await generator(
        { branchEntries: entries, signal: new AbortController().signal } as any,
        {
          model: { id: "working" },
          modelRegistry: {
            complete: async (_model: any, context: any, options: any) => {
              calls++;
              expect(context.messages[0].content[0].text).toContain(
                "Tool evidence. ".repeat(400) + restriction
              );
              expect(options.cacheRetention).toBe("none");
              expect(options.sessionId).toBeTruthy();
              return {
                stopReason: "stop",
                content: [{ type: "text", text: "Do not send without approval." }],
              };
            },
          },
        } as any,
        f.state,
        f.config
      )
    ).toContain("approval");
    expect(calls).toBe(1);
  });

  test("orientation errors distinguish provider length from a live host signal", async () => {
    const f = fixture();
    const generator = createCheckpointHandoffGenerator((async () => ({
      stopReason: "length",
      content: [],
      usage: { output: 4096, reasoning: 4096 },
    })) as any);
    await expect(
      generator(
        { branchEntries: f.entries, signal: new AbortController().signal } as any,
        { model: {}, modelRegistry: {} } as any,
        f.state,
        f.config
      )
    ).rejects.toThrow(
      "stopReason=length; hostAborted=false; outputTokens=4096; reasoningTokens=4096"
    );
  });

  test("provider-local orientation failure retries once then leaves host preparation untouched", async () => {
    const f = fixture();
    let attempts = 0;
    const notices: any[] = [];
    const before = register(f.state, f.config, async () => {
      attempts++;
      throw new Error("provider abort");
    });
    const event = {
      branchEntries: f.entries,
      signal: new AbortController().signal,
      preparation: {
        firstKeptEntryId: "e3",
        tokensBefore: 1000,
        previousSummary: "Prior authorized memory",
      },
    };
    const original = structuredClone(event.preparation);
    expect(
      await before(event, {
        ...hookContext(),
        hasUI: true,
        ui: { notify: (...args: any[]) => notices.push(args) },
      })
    ).toBeUndefined();
    expect(attempts).toBe(2);
    expect(event.preparation).toEqual(original);
    expect(notices.at(-1)?.[1]).toBe("warning");
    expect(f.state.compressionBlocks.every((b) => b.active)).toBe(true);
  });

  test("orientation-free host commit keeps blocks active and resumes an automatic request", async () => {
    const f = fixture();
    const handlers = new Map<string, any>();
    const sent: string[] = [];
    registerDcpNativeCompactionBridge(
      {
        on: (name: string, fn: any) => handlers.set(name, fn),
        appendEntry() {},
        sendUserMessage: (text: string) => sent.push(text),
      } as any,
      f.state,
      f.config,
      async () => {
        throw new Error("unavailable");
      }
    );
    const ctx = { ...hookContext(), compact() {} };
    void triggerDcpNativeCompaction(ctx as any, f.state, "auto");
    const event = {
      branchEntries: f.entries,
      signal: new AbortController().signal,
      preparation: { firstKeptEntryId: "e3", tokensBefore: 1000 },
    };
    expect(await handlers.get("session_before_compact")(event, ctx)).toBeUndefined();
    await handlers.get("session_compact")(
      {
        compactionEntry: { firstKeptEntryId: "e3", details: { readFiles: [], modifiedFiles: [] } },
      },
      ctx
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.state.compressionBlocks.every((b) => b.active)).toBe(true);
    expect(sent).toHaveLength(1);
  });

  test("an oversized fresh orientation falls back to Pi without changing the cut", async () => {
    const f = fixture();
    f.config.nativeCompaction.maxSummaryTokens = 1;
    const before = register(
      f.state,
      f.config,
      async () => "A fresh restriction too large for one token."
    );
    const event = {
      branchEntries: f.entries,
      preparation: { firstKeptEntryId: "e3", tokensBefore: 1000, previousSummary: "old" },
    };
    expect(await before(event, hookContext())).toBeUndefined();
    expect(event.preparation.firstKeptEntryId).toBe("e3");
    expect(event.preparation.previousSummary).toContain("fresh restriction");
  });

  test("retry success supplies a DCP checkpoint at the host's unchanged cut", async () => {
    const f = fixture();
    f.config.nativeCompaction.minHiddenCoverageRatio = 0.5;
    let attempts = 0;
    const before = register(f.state, f.config, async () => {
      if (++attempts === 1) throw new Error("temporary provider failure");
      return "Fresh restrictions";
    });
    const result = await before(
      {
        branchEntries: f.entries,
        signal: new AbortController().signal,
        preparation: { firstKeptEntryId: "e3", tokensBefore: 1000 },
      },
      hookContext()
    );
    expect(attempts).toBe(2);
    expect(result.compaction.firstKeptEntryId).toBe("e3");
    expect(result.compaction.summary).toContain("Fresh restrictions");
  });

  test("Pi abort during orientation stops without a retry or an extension cancel", async () => {
    const f = fixture();
    const abort = new AbortController();
    let attempts = 0;
    const before = register(f.state, f.config, async () => {
      attempts++;
      abort.abort();
      throw new Error("Pi aborted");
    });
    const event = {
      branchEntries: f.entries,
      signal: abort.signal,
      preparation: { firstKeptEntryId: "e3", tokensBefore: 1000, previousSummary: "unchanged" },
    };
    expect(await before(event, hookContext())).toBeUndefined();
    expect(attempts).toBe(1);
    expect(await before(event, hookContext())).toBeUndefined();
    expect(attempts).toBe(1);
    expect(event.preparation.previousSummary).toBe("unchanged");
  });

  test("invalid cut cancels to avoid losing the kept tail; invalid handoff still rejects", async () => {
    const f = fixture();
    for (const setup of [{ cut: "missing", handoff: async () => "unused" }]) {
      const before = register(f.state, f.config, setup.handoff);
      expect(
        await before(
          {
            branchEntries: f.entries,
            preparation: { firstKeptEntryId: setup.cut, tokensBefore: 1000 },
          },
          { hasUI: false }
        )
      ).toEqual({ cancel: true });
    }

    for (const response of [
      { stopReason: "length", content: [{ type: "text", text: "partial" }] },
      { stopReason: "stop", content: [] },
    ]) {
      await expect(
        createCheckpointHandoffGenerator()(
          { branchEntries: f.entries } as any,
          { model: {}, modelRegistry: { complete: async () => response } } as any,
          f.state,
          f.config
        )
      ).rejects.toThrow();
    }
  });

  test("disabled native bridge or extension leaves host compaction untouched", async () => {
    for (const wholeExtension of [false, true]) {
      const f = fixture();
      if (wholeExtension) f.config.enabled = false;
      else f.config.nativeCompaction.enabled = false;
      let calls = 0;
      const before = register(makeState(), f.config, async () => {
        calls++;
        return "fresh";
      });
      expect(
        await before(
          { branchEntries: f.entries, preparation: { firstKeptEntryId: "e1", tokensBefore: 1000 } },
          { hasUI: false }
        )
      ).toBeUndefined();
      expect(calls).toBe(0);
    }
  });
});
