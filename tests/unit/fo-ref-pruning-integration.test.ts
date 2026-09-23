import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyPruning, makeConfig, makeState } from "../helpers/dcp-test-utils.js";
import { hydrateMissingToolRecords } from "../../src/application/tool-recording.js";
import { JevScheduler } from "../../src/application/jev-review.js";
import {
  serializePersistedState,
  restorePersistedState,
} from "../../src/infrastructure/persistence.js";
import { estimateTokens } from "../../src/domain/tokens/estimate.js";
import type { DcpMessage } from "../../src/types/message.js";

const exposedRefsUrl = new URL(
  "../../../../fo-coding-agent/src/runtime/exposed-refs.ts",
  import.meta.url
);
const refsUrl = new URL("../../../../fo-coding-agent/src/runtime/refs.ts", import.meta.url);
const envelopeUrl = new URL("../../../../fo-coding-agent/src/runtime/envelope.ts", import.meta.url);
const realFoAvailable = existsSync(fileURLToPath(exposedRefsUrl));

async function loadRealFo() {
  const [{ foExposedRefBridgeV1 }, { makeRef }, { projectModelText }] = await Promise.all([
    import(exposedRefsUrl.href),
    import(refsUrl.href),
    import(envelopeUrl.href),
  ]);
  return { bridge: foExposedRefBridgeV1, makeRef, projectModelText };
}

function configureRefClearing(config = makeConfig()) {
  config.compress.protectRecentTurns = 1;
  config.strategies.pruneCadenceTurns = 1;
  config.strategies.minPruneItemSavedTokens = 0;
  config.strategies.minPruneBatchSavedTokens = 0;
  config.strategies.customStrategies = {
    enabled: true,
    defaults: { minAgeTurns: 0, minResultTokens: 0 },
    rules: [{ tools: ["read"], action: "clear" }],
  };
  return config;
}

function transcript(outerText: string, details: unknown, includeImage = false): DcpMessage[] {
  const messages: DcpMessage[] = [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "outer-run", name: "run", arguments: { code: "fixture" } }],
    },
    {
      role: "toolResult",
      toolCallId: "outer-run",
      toolName: "run",
      content: [
        { type: "text", text: outerText },
        ...(includeImage ? [{ type: "image", data: "VISIBLE-IMAGE", mimeType: "image/png" }] : []),
      ],
      details,
      isError: false,
    },
    ...Array.from({ length: 8 }, (_, index) => ({ role: "user", content: `follow-up ${index}` })),
  ];
  messages.forEach((message, index) => {
    message.timestamp = 1_000 + index;
  });
  return messages;
}

const realFoTest = test.skipIf(!realFoAvailable);

describe("production fo Ref pruning integration", () => {
  realFoTest("projects grouped exposed Refs without mutating the canonical envelope", async () => {
    const { bridge, makeRef, projectModelText } = await loadRealFo();
    const original = "ORIGINAL-" + "x".repeat(4_000);
    const shared = makeRef("read", original, {
      cwd: "/repo",
      input: "shared.txt",
      timelineId: "inner-shared",
    });
    const envelope: any = {
      kind: "sandbox.result",
      version: 1,
      script: { hash: "integration" },
      emissions: [
        { kind: "text", text: `DERIVED:${original}` },
        { kind: "ref", label: "shown", ref: shared },
        { kind: "value", label: "bundle", data: { repeated: shared, authored: "KEEP-AUTHORED" } },
      ],
      final: { repeated: shared, note: "KEEP-FINAL" },
      timeline: [
        {
          id: "inner-private",
          kind: "tool",
          toolName: "read",
          args: { path: "private.txt" },
          result: { content: [{ type: "text", text: "PRIVATE" }], isError: false },
        },
        {
          id: "inner-shared",
          kind: "tool",
          toolName: "read",
          args: { path: "shared.txt" },
          result: { content: [{ type: "text", text: original }], isError: false },
        },
        {
          id: "inner-error",
          kind: "tool",
          toolName: "bash",
          args: { command: "false" },
          result: { content: [{ type: "text", text: "KEEP-ERROR-NOTICE" }], isError: true },
          isError: true,
        },
      ],
      trace: [],
      budgets: { timedOut: false, calls: 3, visibleBytesTruncated: false },
    };
    const canonicalBefore = structuredClone(envelope);
    const outerText = projectModelText(envelope, 100_000, 100_000).text;
    const messages = transcript(outerText, envelope);
    const state = makeState();
    hydrateMissingToolRecords(messages, state);

    const collected = bridge.collect({ outerToolCallId: "outer-run", details: envelope });
    expect(collected.status).toBe("supported");
    if (collected.status !== "supported") throw new Error("expected real fo bridge support");
    const candidate = collected.candidates.find((item: any) => item.timelineId === "inner-shared");
    if (!candidate) throw new Error("missing shared candidate");
    // Projection/recovery of historical selections survives collector retirement.
    state.prunedToolIds.add(candidate.compositeId);
    state.prunedToolActions.set(candidate.compositeId, { action: "clear" });
    const projected = applyPruning(messages, state, configureRefClearing(), {
      foRefBridge: bridge,
    });
    const outer = projected.find((message: DcpMessage) => message.toolCallId === "outer-run");
    const text = (outer.content as any[])[0].text as string;

    expect(state.prunedToolIds.has("outer-run")).toBe(false);
    expect(state.prunedToolIds.has(candidate.compositeId)).toBe(true);
    expect(text.match(/dcp_recover\(\{id:/g)).toHaveLength(3);
    expect(text).toContain(`dcp_recover({id:${JSON.stringify(candidate.compositeId)}})`);
    expect(text).toContain(`DERIVED:${original}`);
    expect(text).toContain("KEEP-AUTHORED");
    expect(text).toContain("KEEP-FINAL");
    expect(text).toContain("KEEP-ERROR-NOTICE");
    expect(text).not.toContain("PRIVATE");
    expect(outer.details).toBe(envelope);
    expect(envelope).toEqual(canonicalBefore);

    const recovered = bridge.recover({
      outerToolCallId: "outer-run",
      details: envelope,
      localId: candidate.localId,
    });
    expect(recovered.status).toBe("recovered");
    expect(recovered.ref.value).toBe(original);
    expect(envelope).toEqual(canonicalBefore);
  });

  realFoTest(
    "preserves post-stripRefImages results when image attribution is unavailable",
    async () => {
      const { bridge, makeRef, projectModelText } = await loadRealFo();
      const original = "IMAGE-SOURCE-" + "i".repeat(3_000);
      const shared: any = makeRef(
        "read",
        original,
        { cwd: "/repo", input: "plot.png", timelineId: "inner-image" },
        { images: [{ type: "image", data: "REF-IMAGE", mimeType: "image/png" }] }
      );
      const envelope: any = {
        kind: "sandbox.result",
        version: 1,
        script: { hash: "post-strip-images" },
        emissions: [{ kind: "ref", ref: shared }],
        final: undefined,
        timeline: [
          {
            id: "inner-image",
            kind: "tool",
            toolName: "read",
            args: { path: "plot.png" },
            result: {
              content: [
                { type: "text", text: original },
                { type: "image", data: "REF-IMAGE", mimeType: "image/png" },
              ],
              isError: false,
            },
          },
        ],
        trace: [],
        budgets: { timedOut: false, calls: 1, visibleBytesTruncated: false },
      };
      const outerText = projectModelText(envelope, 100_000, 100_000).text;
      delete shared.images;
      const canonicalAfterStrip = structuredClone(envelope);
      const messages = transcript(outerText, envelope, true);
      const state = makeState();
      hydrateMissingToolRecords(messages, state);
      const collected = bridge.collect({ outerToolCallId: "outer-run", details: envelope });
      if (collected.status !== "supported") throw new Error("expected stripped envelope support");
      const candidate = collected.candidates[0];

      const projected = applyPruning(messages, state, configureRefClearing(), {
        foRefBridge: bridge,
      });
      const outer = projected.find((message: DcpMessage) => message.toolCallId === "outer-run");
      expect(state.prunedToolIds.has(candidate.compositeId)).toBe(false);
      expect((outer.content as any[])[0].text).toBe(outerText);
      expect((outer.content as any[])[1]).toEqual({
        type: "image",
        data: "VISIBLE-IMAGE",
        mimeType: "image/png",
      });
      expect(outer.details).toBe(envelope);
      expect(envelope).toEqual(canonicalAfterStrip);
    }
  );

  realFoTest(
    "live Jev applies repeated exposed Ref only when actual projected savings clears the gate",
    async () => {
      const { bridge, makeRef, projectModelText } = await loadRealFo();
      const original = "several distinct words of evidence ".repeat(180);
      const shared = makeRef("read", original, {
        cwd: "/repo",
        input: "same.txt",
        timelineId: "inner-live",
      });
      const envelope: any = {
        kind: "sandbox.result",
        version: 1,
        script: { hash: "live" },
        emissions: [{ kind: "ref", ref: shared }],
        final: shared,
        timeline: [
          {
            id: "inner-live",
            kind: "tool",
            toolName: "read",
            args: { path: "same.txt" },
            result: { content: [{ type: "text", text: original }], isError: false },
          },
        ],
        trace: [],
        budgets: { timedOut: false, calls: 1, visibleBytesTruncated: false },
      };
      const outerText = projectModelText(envelope, 100_000, 100_000).text;
      const collected = bridge.collect({ outerToolCallId: "outer-run", details: envelope });
      if (collected.status !== "supported") throw new Error("expected supported bridge");
      const candidate = collected.candidates[0];
      const marker = `[Output removed by DCP; original retained: dcp_recover({id:${JSON.stringify(candidate.compositeId)}})]`;
      const direct = bridge.project({
        outerToolCallId: "outer-run",
        details: envelope,
        originalModelText: outerText,
        decisions: { [candidate.localId]: marker },
        maxVisibleBytes: Buffer.byteLength(outerText),
        maxVisibleEventBytes: Buffer.byteLength(outerText),
      });
      if (direct.status !== "projected") throw new Error("expected direct projection");
      const actual = estimateTokens(outerText) - estimateTokens(direct.modelText);
      const messages = transcript(outerText, envelope);
      const state = makeState();
      hydrateMissingToolRecords(messages, state);
      const config = configureRefClearing();
      config.strategies.candidates.minAgeTurns = 0;
      config.strategies.candidates.minResultTokens = 1;
      config.strategies.jev = { enabled: true, apply: true };
      config.strategies.minPruneBatchSavedTokens = 0;
      applyPruning(messages, state, config, { foRefBridge: bridge });
      const scheduler = new JevScheduler({
        read: async () => [],
        append: async () => {},
        request: async () => ({
          answers: {
            retention: {
              type: "choice",
              choice: "drop",
              confidence: 0.2,
              probabilities: { keep: 0.3, drop: 0.7 },
            },
          },
        }),
      });
      scheduler.observe(messages, state, config, "fo-live", bridge);
      await new Promise((resolve) => setTimeout(resolve, 15));
      const drops = scheduler.pending("fo-live", config);
      expect(drops.get(candidate.compositeId)).toBe(original);
      config.strategies.minPruneItemSavedTokens = actual + 1;
      applyPruning(messages, state, config, { foRefBridge: bridge, jevDrops: drops });
      expect(state.prunedToolIds.has(candidate.compositeId)).toBe(false);
      config.strategies.minPruneItemSavedTokens = actual;
      const rendered = applyPruning(messages, state, config, {
        foRefBridge: bridge,
        jevDrops: drops,
      });
      expect(state.prunedToolIds.has(candidate.compositeId)).toBe(true);
      expect(state.lastHeuristicPruneDecision?.batchSavedTokens).toBe(actual);
      expect((rendered[1].content as any[])[0].text).toContain(marker);
      const resumed = makeState();
      restorePersistedState(serializePersistedState(state), resumed);
      expect(resumed.prunedToolIds.has(candidate.compositeId)).toBe(true);
      expect(resumed.prunedToolActions.get(candidate.compositeId)).toEqual({ action: "clear" });
      hydrateMissingToolRecords(messages, resumed);
      const resumedText = (
        applyPruning(messages, resumed, config, { foRefBridge: bridge })[1].content as any[]
      )[0].text;
      expect(resumedText).toContain(marker);
      expect(
        bridge.recover({
          outerToolCallId: "outer-run",
          details: envelope,
          localId: candidate.localId,
        }).ref.value
      ).toBe(original);
    }
  );

  realFoTest("uses repeated-exposure projected savings for the combined batch gate", async () => {
    const { bridge, makeRef, projectModelText } = await loadRealFo();
    const original = "z".repeat(5_000);
    const shared = makeRef("read", original, {
      cwd: "/repo",
      input: "same.txt",
      timelineId: "inner-same",
    });
    const envelope: any = {
      kind: "sandbox.result",
      version: 1,
      script: { hash: "gate" },
      emissions: [{ kind: "ref", ref: shared }],
      final: shared,
      timeline: [
        {
          id: "inner-same",
          kind: "tool",
          toolName: "read",
          args: { path: "same.txt" },
          result: { content: [{ type: "text", text: original }], isError: false },
        },
      ],
      trace: [],
      budgets: { timedOut: false, calls: 1, visibleBytesTruncated: false },
    };
    const outerText = projectModelText(envelope, 100_000, 100_000).text;
    const collected = bridge.collect({ outerToolCallId: "outer-run", details: envelope });
    if (collected.status !== "supported") throw new Error("expected supported bridge");
    const candidate = collected.candidates[0];
    const marker = `[Output removed by DCP; original retained: dcp_recover({id:${JSON.stringify(candidate.compositeId)}})]`;
    const direct = bridge.project({
      outerToolCallId: "outer-run",
      details: envelope,
      originalModelText: outerText,
      decisions: { [candidate.localId]: marker },
      maxVisibleBytes: Buffer.byteLength(outerText, "utf8"),
      maxVisibleEventBytes: Buffer.byteLength(outerText, "utf8"),
    });
    if (direct.status !== "projected") throw new Error("expected direct projection");
    const actualBatchSaving = estimateTokens(outerText) - estimateTokens(direct.modelText);
    const oneExposureEstimate = estimateTokens(original) - estimateTokens(marker);
    expect(actualBatchSaving).toBeGreaterThan(oneExposureEstimate);

    const messages = transcript(outerText, envelope);
    const state = makeState();
    hydrateMissingToolRecords(messages, state);
    const config = configureRefClearing();
    config.strategies.minPruneBatchSavedTokens = oneExposureEstimate + 1;
    config.strategies.deduplication.enabled = true;
    messages.push(
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "same-new", name: "read", arguments: { path: "same.txt" } },
        ],
        timestamp: 2000,
      },
      {
        role: "toolResult",
        toolCallId: "same-new",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: original }],
        timestamp: 2001,
      }
    );
    hydrateMissingToolRecords(messages, state);
    const projected = applyPruning(messages, state, config, { foRefBridge: bridge });

    expect(state.prunedToolIds.has(candidate.compositeId)).toBe(true);
    expect(state.lastHeuristicPruneDecision?.batchSavedTokens).toBe(actualBatchSaving);
    const projectedOuter = projected.find(
      (message: DcpMessage) => message.toolCallId === "outer-run"
    );
    expect((projectedOuter.content as any[])[0].text).toContain(marker);
  });

  realFoTest(
    "keeps persisted composite selections through missing-bridge and resumed passes",
    async () => {
      const { bridge, makeRef, projectModelText } = await loadRealFo();
      const original = "resume-" + "r".repeat(2_000);
      const shared = makeRef("read", original, {
        cwd: "/repo",
        input: "resume.txt",
        timelineId: "inner-resume",
      });
      const envelope: any = {
        kind: "sandbox.result",
        version: 1,
        script: { hash: "resume" },
        emissions: [{ kind: "ref", ref: shared }],
        final: undefined,
        timeline: [
          {
            id: "inner-resume",
            kind: "tool",
            toolName: "read",
            args: { path: "resume.txt" },
            result: { content: [{ type: "text", text: original }], isError: false },
          },
        ],
        trace: [],
        budgets: { timedOut: false, calls: 1, visibleBytesTruncated: false },
      };
      const outerText = projectModelText(envelope, 100_000, 100_000).text;
      const collected = bridge.collect({ outerToolCallId: "outer-run", details: envelope });
      if (collected.status !== "supported") throw new Error("expected supported bridge");
      const candidate = collected.candidates[0];
      const messages = transcript(outerText, envelope);
      const state = makeState();
      hydrateMissingToolRecords(messages, state);
      state.prunedToolIds.add(candidate.compositeId);
      state.prunedToolActions.set(candidate.compositeId, { action: "clear" });

      const withoutBridge = applyPruning(messages, state, configureRefClearing());
      expect(state.prunedToolIds.has(candidate.compositeId)).toBe(true);
      expect(JSON.stringify(withoutBridge)).toContain(original);

      const resumed = applyPruning(messages, state, configureRefClearing(), {
        foRefBridge: bridge,
      });
      expect(state.prunedToolIds.has(candidate.compositeId)).toBe(true);
      const resumedOuter = resumed.find(
        (message: DcpMessage) => message.toolCallId === "outer-run"
      );
      expect((resumedOuter.content as any[])[0].text).toContain(
        `dcp_recover({id:${JSON.stringify(candidate.compositeId)}})`
      );
    }
  );

  realFoTest("keeps virtual results in transcript order for cross-boundary dedup", async () => {
    const { bridge, makeRef, projectModelText } = await loadRealFo();
    const original = "same observation " + "s".repeat(2_000);
    const exposed = makeRef("read", original, {
      cwd: "/repo",
      input: { path: "same.txt" },
      timelineId: "inner-old",
    });
    const envelope: any = {
      kind: "sandbox.result",
      version: 1,
      script: { hash: "ordered-dedup" },
      emissions: [{ kind: "ref", ref: exposed }],
      timeline: [
        {
          id: "inner-old",
          kind: "tool",
          toolName: "read",
          args: { path: "same.txt" },
          result: { content: [{ type: "text", text: original }], isError: false },
        },
      ],
      trace: [],
      budgets: { timedOut: false, calls: 1, visibleBytesTruncated: false },
    };
    const outerText = projectModelText(envelope, 100_000, 100_000).text;
    const messages: DcpMessage[] = [
      ...transcript(outerText, envelope).slice(0, 2),
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "ordinary-new", name: "read", arguments: { path: "same.txt" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "ordinary-new",
        toolName: "read",
        content: [{ type: "text", text: original }],
        isError: false,
      },
      ...Array.from({ length: 8 }, (_, index) => ({ role: "user", content: `later ${index}` })),
    ];
    messages.forEach((message, index) => {
      message.timestamp = 4_000 + index;
    });
    const state = makeState();
    hydrateMissingToolRecords(messages, state);
    const config = makeConfig();
    config.compress.protectRecentTurns = 1;
    config.strategies.pruneCadenceTurns = 1;
    config.strategies.deduplication.enabled = true;
    const collected = bridge.collect({ outerToolCallId: "outer-run", details: envelope });
    if (collected.status !== "supported") throw new Error("expected supported bridge");
    const candidate = collected.candidates[0];

    applyPruning(messages, state, config, { foRefBridge: bridge });
    expect(state.prunedToolIds.has(candidate.compositeId)).toBe(true);
    expect(state.prunedToolIds.has("ordinary-new")).toBe(false);
  });

  realFoTest(
    "keeps a successful exposed retry that supports a persisted exposed error",
    async () => {
      const { bridge, makeRef, projectModelText } = await loadRealFo();
      const input = { command: "check" };
      const failed = makeRef("bash", "FAILED-" + "f".repeat(2_000), {
        cwd: "/repo",
        input,
        timelineId: "inner-failed",
        error: "failed",
      });
      const succeeded = makeRef("bash", "SUCCESS-" + "s".repeat(2_000), {
        cwd: "/repo",
        input,
        timelineId: "inner-success",
      });
      const envelope = (ref: any, id: string, isError: boolean): any => ({
        kind: "sandbox.result",
        version: 1,
        script: { hash: id },
        emissions: [{ kind: "ref", ref }],
        timeline: [
          {
            id,
            kind: "tool",
            toolName: "bash",
            args: input,
            result: { content: [{ type: "text", text: ref.value }], isError },
            isError,
          },
        ],
        trace: [],
        budgets: { timedOut: false, calls: 1, visibleBytesTruncated: false },
      });
      const failedEnvelope = envelope(failed, "inner-failed", true);
      const successEnvelope = envelope(succeeded, "inner-success", false);
      const messages: DcpMessage[] = [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "outer-failed", name: "run", arguments: {} }],
        },
        {
          role: "toolResult",
          toolCallId: "outer-failed",
          toolName: "run",
          content: [{ type: "text", text: projectModelText(failedEnvelope, 100_000).text }],
          details: failedEnvelope,
        },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "outer-success", name: "run", arguments: {} }],
        },
        {
          role: "toolResult",
          toolCallId: "outer-success",
          toolName: "run",
          content: [{ type: "text", text: projectModelText(successEnvelope, 100_000).text }],
          details: successEnvelope,
        },
        ...Array.from({ length: 8 }, (_, index) => ({ role: "user", content: `later ${index}` })),
      ];
      messages.forEach((message, index) => {
        message.timestamp = 5_000 + index;
      });
      const state = makeState();
      hydrateMissingToolRecords(messages, state);
      const failedCollection = bridge.collect({
        outerToolCallId: "outer-failed",
        details: failedEnvelope,
      });
      const successCollection = bridge.collect({
        outerToolCallId: "outer-success",
        details: successEnvelope,
      });
      if (failedCollection.status !== "supported" || successCollection.status !== "supported")
        throw new Error("expected supported bridges");
      const failedId = failedCollection.candidates[0].compositeId;
      const successId = successCollection.candidates[0].compositeId;
      state.prunedToolIds.add(failedId);
      state.prunedToolActions.set(failedId, { action: "clear" });
      const config = configureRefClearing();
      config.strategies.customStrategies.rules = [{ tools: ["bash"], action: "clear" }];

      const projected = applyPruning(messages, state, config, { foRefBridge: bridge });
      expect(state.prunedToolIds.has(failedId)).toBe(true);
      expect(state.prunedToolIds.has(successId)).toBe(false);
      const successOuter = projected.find(
        (message: DcpMessage) => message.toolCallId === "outer-success"
      );
      expect((successOuter.content as any[])[0].text).toContain("SUCCESS-");
    }
  );

  realFoTest(
    "uses a later exposed success when validating an ordinary error tombstone",
    async () => {
      const { bridge, makeRef, projectModelText } = await loadRealFo();
      const input = { path: "cross-boundary.ts" };
      const success = makeRef("read", "SUCCESS-" + "s".repeat(2_000), {
        cwd: "/repo",
        input,
        timelineId: "inner-success",
      });
      const envelope: any = {
        kind: "sandbox.result",
        version: 1,
        script: { hash: "cross-boundary-success" },
        emissions: [{ kind: "ref", ref: success }],
        timeline: [
          {
            id: "inner-success",
            kind: "tool",
            toolName: "read",
            args: input,
            result: { content: [{ type: "text", text: success.value }], isError: false },
          },
        ],
        trace: [],
        budgets: { timedOut: false, calls: 1, visibleBytesTruncated: false },
      };
      const messages: DcpMessage[] = [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "ordinary-failed", name: "read", arguments: input }],
        },
        {
          role: "toolResult",
          toolCallId: "ordinary-failed",
          toolName: "read",
          isError: true,
          content: [{ type: "text", text: "FAILED-" + "f".repeat(2_000) }],
        },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "outer-run", name: "run", arguments: {} }],
        },
        {
          role: "toolResult",
          toolCallId: "outer-run",
          toolName: "run",
          content: [{ type: "text", text: projectModelText(envelope, 100_000).text }],
          details: envelope,
        },
        ...Array.from({ length: 8 }, (_, index) => ({ role: "user", content: `later ${index}` })),
      ];
      messages.forEach((message, index) => {
        message.timestamp = 6_000 + index;
      });
      const state = makeState();
      hydrateMissingToolRecords(messages, state);
      const config = makeConfig();
      config.compress.protectRecentTurns = 1;
      config.strategies.pruneCadenceTurns = 1;
      config.strategies.purgeErrors.enabled = true;
      config.strategies.purgeErrors.turns = 0;

      // Existing compatible error tombstones still validate against exposed retries.
      state.prunedToolIds.add("ordinary-failed");
      state.prunedToolActions.set("ordinary-failed", { action: "clear" });
      const projected = applyPruning(messages, state, config, { foRefBridge: bridge });
      expect(state.prunedToolIds.has("ordinary-failed")).toBe(true);
      const failedResult = projected.find(
        (message: DcpMessage) => message.toolCallId === "ordinary-failed"
      );
      expect((failedResult.content as any[])[0].text).toContain(
        'dcp_recover({id:"ordinary-failed"})'
      );
    }
  );

  realFoTest(
    "protects exposed dcp_recover output and lifts persisted composite actions",
    async () => {
      const { bridge, makeRef, projectModelText } = await loadRealFo();
      const original = "RECOVERED-" + "o".repeat(2_000);
      const exposed = makeRef("dcp_recover", original, {
        cwd: "/repo",
        input: { id: "prior" },
        timelineId: "inner-recover",
      });
      const envelope: any = {
        kind: "sandbox.result",
        version: 1,
        script: { hash: "protected-recover" },
        emissions: [{ kind: "ref", ref: exposed }],
        timeline: [
          {
            id: "inner-recover",
            kind: "tool",
            toolName: "dcp_recover",
            args: { id: "prior" },
            result: { content: [{ type: "text", text: original }], isError: false },
          },
        ],
        trace: [],
        budgets: { timedOut: false, calls: 1, visibleBytesTruncated: false },
      };
      const outerText = projectModelText(envelope, 100_000, 100_000).text;
      const messages = transcript(outerText, envelope);
      const state = makeState();
      hydrateMissingToolRecords(messages, state);
      const collected = bridge.collect({ outerToolCallId: "outer-run", details: envelope });
      if (collected.status !== "supported") throw new Error("expected supported bridge");
      const candidate = collected.candidates[0];
      state.prunedToolIds.add(candidate.compositeId);
      state.prunedToolActions.set(candidate.compositeId, { action: "clear" });
      const config = configureRefClearing();
      config.strategies.customStrategies.rules = [{ tools: ["*"], action: "clear" }];

      const projected = applyPruning(messages, state, config, { foRefBridge: bridge });
      const outer = projected.find((message: DcpMessage) => message.toolCallId === "outer-run");
      expect(state.prunedToolIds.has(candidate.compositeId)).toBe(false);
      expect((outer.content as any[])[0].text).toBe(outerText);
      expect((outer.content as any[])[0].text).toContain(original);
    }
  );
});

describe("heuristic pruning safety dependencies", () => {
  test("deprecated settings clear neither the error nor its successful retry", () => {
    const long = (prefix: string) => `${prefix}\n${"detail\n".repeat(400)}`;
    const messages: DcpMessage[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "failed", name: "read", arguments: { path: "same.ts" } }],
      },
      {
        role: "toolResult",
        toolCallId: "failed",
        toolName: "read",
        isError: true,
        content: [{ type: "text", text: long("failure evidence") }],
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "retry", name: "read", arguments: { path: "same.ts" } }],
      },
      {
        role: "toolResult",
        toolCallId: "retry",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: long("successful retry") }],
      },
      ...Array.from({ length: 8 }, (_, index) => ({ role: "user", content: `later ${index}` })),
    ];
    messages.forEach((message, index) => {
      message.timestamp = 2_000 + index;
    });
    const state = makeState();
    hydrateMissingToolRecords(messages, state);
    const config = configureRefClearing();
    config.strategies.purgeErrors.enabled = true;
    config.strategies.purgeErrors.turns = 0;

    const projected = applyPruning(messages, state, config);
    expect(state.prunedToolIds.has("retry")).toBe(false);
    expect(state.prunedToolIds.has("failed")).toBe(false);
    expect(JSON.stringify(projected)).toContain("failure evidence");
  });

  test("never automatically prunes dcp_recover output and lifts old selections", () => {
    const messages: DcpMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "recovery", name: "dcp_recover", arguments: { id: "old" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "recovery",
        toolName: "dcp_recover",
        content: [{ type: "text", text: "RECOVERED-ORIGINAL" }],
      },
      ...Array.from({ length: 8 }, (_, index) => ({ role: "user", content: `later ${index}` })),
    ];
    messages.forEach((message, index) => {
      message.timestamp = 3_000 + index;
    });
    const state = makeState();
    hydrateMissingToolRecords(messages, state);
    state.prunedToolIds.add("recovery");
    state.prunedToolActions.set("recovery", { action: "clear" });
    const config = configureRefClearing();
    config.strategies.customStrategies.rules = [{ tools: ["*"], action: "clear" }];

    const projected = applyPruning(messages, state, config);
    expect(state.prunedToolIds.has("recovery")).toBe(false);
    expect(JSON.stringify(projected)).toContain("RECOVERED-ORIGINAL");
  });
});
