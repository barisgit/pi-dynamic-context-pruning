import { describe, expect, test } from "bun:test";
import {
  collectFoRefAdapterCandidates,
  projectFoRefOuterResult,
  type FoRefBridgeV1,
  type FoRefCandidateV1,
} from "../../src/domain/pruning/fo-ref-adapter.js";
import type { DcpMessage } from "../../src/types/message.js";
import type { PrunedToolAction, ToolRecord } from "../../src/types/state.js";

const outerToolCallId = "outer-run-1";

function candidate(overrides: Partial<FoRefCandidateV1> = {}): FoRefCandidateV1 {
  return {
    localId: "timeline:inner-1",
    compositeId: "fo-ref:v1:outer-run-1:timeline%3Ainner-1",
    outerToolCallId,
    timelineId: "inner-1",
    toolName: "read",
    input: { path: "large.txt" },
    content: [{ type: "text", text: "line 1\nline 2\nline 3\nline 4" }],
    isError: false,
    text: "line 1\nline 2\nline 3\nline 4",
    exposureCount: 2,
    exposureIds: ["shown", "returned"],
    ...overrides,
  };
}

function fakeBridge(candidates: FoRefCandidateV1[], unsupported = false) {
  const calls: Record<string, string>[] = [];
  const bridge: FoRefBridgeV1 = {
    version: 1,
    registryKey: "fo.exposed-ref-bridge.v1",
    collect: () =>
      unsupported
        ? { status: "unsupported" }
        : { status: "supported", version: 1, envelopeVersion: 1, candidates },
    project: (request) => {
      calls.push({ ...request.decisions });
      if (unsupported) {
        return {
          status: "unchanged",
          modelText: request.originalModelText,
          appliedLocalIds: [],
          ignoredLocalIds: Object.keys(request.decisions),
        };
      }
      const replacements = Object.entries(request.decisions)
        .map(([id, replacement]) => `${id}=${replacement}`)
        .join("|");
      const modelText = replacements ? `projected:${replacements}` : request.originalModelText;
      return {
        status: "projected",
        modelText,
        fullModelText: `full:${modelText}`,
        truncated: false,
        originalModelText: request.originalModelText,
        originalFullModelText: `full:${request.originalModelText}`,
        originalTruncated: false,
        savedModelTextCharacters: request.originalModelText.length - modelText.length,
        savedFullModelTextCharacters: request.originalModelText.length - modelText.length,
        appliedLocalIds: Object.keys(request.decisions),
        ignoredLocalIds: [],
      };
    },
    recover: () => ({ status: "unavailable" }),
  };
  return { bridge, calls };
}

const outerRecord: ToolRecord = {
  toolCallId: outerToolCallId,
  toolName: "run",
  inputArgs: { code: "return ref" },
  inputFingerprint: "outer",
  isError: false,
  turnIndex: 17,
  timestamp: 123456,
  tokenEstimate: 900,
};

const outerMessage: DcpMessage = {
  role: "toolResult",
  toolCallId: outerToolCallId,
  toolName: "run",
  content: [{ type: "text", text: "ORIGINAL OUTER MODEL TEXT" }],
  details: { kind: "sandbox.result", version: 1, retained: true },
  isError: false,
  timestamp: outerRecord.timestamp,
};

describe("fo Ref adapter candidate collection", () => {
  test("creates one virtual result and ToolRecord per grouped candidate", () => {
    const exposed = candidate();
    const { bridge } = fakeBridge([exposed]);
    const result = collectFoRefAdapterCandidates({
      bridge,
      outerToolCallId,
      details: outerMessage.details,
      outerRecord,
    });

    expect(result.status).toBe("supported");
    if (result.status !== "supported") throw new Error("expected supported adapter");
    expect(result.messages).toEqual([
      {
        role: "toolResult",
        toolCallId: exposed.compositeId,
        toolName: "read",
        content: exposed.content,
        isError: false,
        timestamp: outerRecord.timestamp,
      },
    ]);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      toolCallId: exposed.compositeId,
      toolName: "read",
      inputArgs: { path: "large.txt" },
      isError: false,
      turnIndex: outerRecord.turnIndex,
      timestamp: outerRecord.timestamp,
    });
    expect(result.records[0]?.tokenEstimate).toBeGreaterThan(0);
    expect(result.records[0]?.inputFingerprint).toContain("read");
    expect(result.groupedSourceRefs).toEqual([
      {
        outerToolCallId,
        localId: exposed.localId,
        compositeId: exposed.compositeId,
        timelineId: exposed.timelineId,
        exposureIds: exposed.exposureIds,
      },
    ]);
    expect(result.liveCompositeIds).toEqual([exposed.compositeId]);
  });

  test("normalizes non-object historical candidate input without losing it", () => {
    const exposed = candidate({ input: "legacy-path" });
    const { bridge } = fakeBridge([exposed]);
    const result = collectFoRefAdapterCandidates({
      bridge,
      outerToolCallId,
      details: {},
      outerRecord,
    });
    expect(result.status === "supported" ? result.records[0]?.inputArgs : null).toEqual({
      input: "legacy-path",
    });
  });
});

describe("fo Ref adapter projection", () => {
  test("overlays persisted and proposed actions while preserving details", () => {
    const first = candidate();
    const second = candidate({
      localId: "timeline:inner-2",
      compositeId: "fo-ref:v1:outer-run-1:timeline%3Ainner-2",
      timelineId: "inner-2",
      toolName: "grep",
      input: { pattern: "needle" },
      text: "a\nb\nc\nd\ne",
      content: [{ type: "text", text: "a\nb\nc\nd\ne" }],
      exposureCount: 1,
      exposureIds: ["nested"],
    });
    const { bridge, calls } = fakeBridge([first, second]);
    const persisted = new Map<string, PrunedToolAction>([[first.compositeId, { action: "clear" }]]);
    const proposed = new Map<string, PrunedToolAction>([
      [second.compositeId, { action: "reduce", headLines: 1, tailLines: 1 }],
    ]);

    const result = projectFoRefOuterResult({
      bridge,
      outerMessage,
      outerToolCallId,
      details: outerMessage.details,
      persistedActions: persisted,
      proposedActions: proposed,
      maxVisibleBytes: 10_000,
    });

    expect(result.status).toBe("projected");
    if (result.status !== "projected") throw new Error("expected projected adapter");
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({});
    expect(calls[1]?.[first.localId]).toContain(
      `dcp_recover({id:${JSON.stringify(first.compositeId)}})`
    );
    expect(calls[1]?.[second.localId]).toBeUndefined();
    expect(calls[2]?.[first.localId]).toContain(
      `dcp_recover({id:${JSON.stringify(first.compositeId)}})`
    );
    expect(calls[2]?.[second.localId]).toBe(
      `a\n[... 3 lines removed by DCP; original retained: dcp_recover({id:${JSON.stringify(second.compositeId)}}) ...]\ne`
    );
    expect(result.originalText).toBe("ORIGINAL OUTER MODEL TEXT");
    expect(result.baselineText).toContain(first.localId);
    expect(result.baselineText).not.toContain(second.localId);
    expect(result.projectedText).toContain(second.localId);
    expect(result.originalFullText).toBe("full:ORIGINAL OUTER MODEL TEXT");
    expect(result.baselineFullText).toContain(first.localId);
    expect(result.projectedFullText).toContain(second.localId);
    expect(result.appliedCompositeIds).toEqual([first.compositeId, second.compositeId]);
    expect(result.ignoredCompositeIds).toEqual([]);
    expect(result.message).not.toBe(outerMessage);
    expect((result.message.content as any[])[0].text).toBe(result.projectedText);
    expect(result.message.details).toBe(outerMessage.details);
    expect((outerMessage.content as any[])[0].text).toBe("ORIGINAL OUTER MODEL TEXT");
  });

  test("lets proposed actions override persisted actions for hypothetical measurement", () => {
    const exposed = candidate();
    const { bridge, calls } = fakeBridge([exposed]);
    projectFoRefOuterResult({
      bridge,
      outerMessage,
      outerToolCallId,
      details: outerMessage.details,
      persistedActions: new Map([[exposed.compositeId, { action: "clear" }]]),
      proposedActions: new Map([
        [exposed.compositeId, { action: "reduce", headLines: 1, tailLines: 1 }],
      ]),
      maxVisibleBytes: 10_000,
    });
    expect(calls[2]?.[exposed.localId]).toBe(
      `line 1\n[... 2 lines removed by DCP; original retained: dcp_recover({id:${JSON.stringify(exposed.compositeId)}}) ...]\nline 4`
    );
  });

  test("reports bridge-ignored decisions instead of claiming they were applied", () => {
    const exposed = candidate();
    const base = fakeBridge([exposed]).bridge;
    const bridge: FoRefBridgeV1 = {
      ...base,
      project: (request) => ({
        status: "projected",
        modelText: request.originalModelText,
        fullModelText: request.originalModelText,
        truncated: false,
        originalModelText: request.originalModelText,
        originalFullModelText: request.originalModelText,
        originalTruncated: false,
        savedModelTextCharacters: 0,
        savedFullModelTextCharacters: 0,
        appliedLocalIds: [],
        ignoredLocalIds: Object.keys(request.decisions),
      }),
    };
    const result = projectFoRefOuterResult({
      bridge,
      outerMessage,
      outerToolCallId,
      details: outerMessage.details,
      persistedActions: new Map([[exposed.compositeId, { action: "clear" }]]),
      maxVisibleBytes: 100,
    });
    expect(result.status).toBe("projected");
    if (result.status !== "projected") throw new Error("expected projected adapter");
    expect(result.appliedCompositeIds).toEqual([]);
    expect(result.ignoredCompositeIds).toEqual([exposed.compositeId]);
  });

  test("exposes faithful clipped visible and full text for repeated-exposure savings", () => {
    const repeatedText = "X".repeat(800);
    const exposed = candidate({
      text: repeatedText,
      content: [{ type: "text", text: repeatedText }],
    });
    const canonicalFull = `before:${repeatedText}:middle:${repeatedText}:after`;
    const maxVisibleBytes = 70;
    const seenEventLimits: Array<number | undefined> = [];
    const bridge: FoRefBridgeV1 = {
      version: 1,
      registryKey: "fo.exposed-ref-bridge.v1",
      collect: () => ({
        status: "supported",
        version: 1,
        envelopeVersion: 1,
        candidates: [exposed],
      }),
      project: (request) => {
        seenEventLimits.push(request.maxVisibleEventBytes);
        const replacement = request.decisions[exposed.localId];
        const fullModelText =
          replacement === undefined
            ? canonicalFull
            : canonicalFull.split(repeatedText).join(replacement);
        const modelText = fullModelText.slice(0, request.maxVisibleBytes);
        return {
          status: "projected",
          modelText,
          fullModelText,
          truncated: modelText.length < fullModelText.length,
          originalModelText: request.originalModelText,
          originalFullModelText: canonicalFull,
          originalTruncated: true,
          savedModelTextCharacters: request.originalModelText.length - modelText.length,
          savedFullModelTextCharacters: canonicalFull.length - fullModelText.length,
          appliedLocalIds: replacement === undefined ? [] : [exposed.localId],
          ignoredLocalIds: [],
        };
      },
      recover: () => ({ status: "unavailable" }),
    };
    const clippedOuter: DcpMessage = {
      ...outerMessage,
      content: [{ type: "text", text: canonicalFull.slice(0, maxVisibleBytes) }],
    };
    const result = projectFoRefOuterResult({
      bridge,
      outerMessage: clippedOuter,
      outerToolCallId,
      details: clippedOuter.details,
      persistedActions: new Map(),
      proposedActions: new Map([[exposed.compositeId, { action: "clear" }]]),
      maxVisibleBytes,
      maxVisibleEventBytes: 55,
    });
    expect(result.status).toBe("projected");
    if (result.status !== "projected") throw new Error("expected projected adapter");
    expect(seenEventLimits).toEqual([55, 55]);
    expect(result.originalText).toBe(canonicalFull.slice(0, maxVisibleBytes));
    expect(result.baselineText).toBe(canonicalFull.slice(0, maxVisibleBytes));
    expect(result.originalFullText).toBe(canonicalFull);
    expect(result.baselineFullText).toBe(canonicalFull);
    expect(result.projectedFullText.match(/dcp_recover\(\{id:/g)).toHaveLength(2);
    expect(result.projectedFullText.length).toBeLessThan(result.baselineFullText.length);
    expect(result.projectedText.length).toBe(maxVisibleBytes);
    expect(result.projectedText.length).toBe(result.baselineText.length);
    expect(result.appliedCompositeIds).toEqual([exposed.compositeId]);
    expect(result.ignoredCompositeIds).toEqual([]);
  });

  test("fails closed when outer nontext blocks cannot be attributed to stripped Refs", () => {
    const exposed = candidate();
    const { bridge, calls } = fakeBridge([exposed]);
    const withImage: DcpMessage = {
      ...outerMessage,
      content: [
        { type: "text", text: "ORIGINAL OUTER MODEL TEXT" },
        { type: "image", data: "BASE64", mimeType: "image/png" },
      ],
    };
    const result = projectFoRefOuterResult({
      bridge,
      outerMessage: withImage,
      outerToolCallId,
      details: withImage.details,
      persistedActions: new Map(),
      proposedActions: new Map([[exposed.compositeId, { action: "clear" }]]),
      maxVisibleBytes: 10_000,
    });
    expect(result.status).toBe("unchanged");
    expect(result.message).toBe(withImage);
    expect(result.liveCompositeIds).toEqual([exposed.compositeId]);
    expect(calls).toHaveLength(0);
  });

  test("keeps unsupported and ambiguous outer outputs unchanged", () => {
    const { bridge } = fakeBridge([], true);
    const unsupported = projectFoRefOuterResult({
      bridge,
      outerMessage,
      outerToolCallId,
      details: outerMessage.details,
      persistedActions: new Map(),
      maxVisibleBytes: 100,
    });
    expect(unsupported).toEqual({
      status: "unchanged",
      message: outerMessage,
      originalText: "ORIGINAL OUTER MODEL TEXT",
      liveCompositeIds: [],
      groupedSourceRefs: [],
    });

    const ambiguous: DcpMessage = {
      ...outerMessage,
      content: [
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ],
    };
    const supported = fakeBridge([candidate()]).bridge;
    const unchanged = projectFoRefOuterResult({
      bridge: supported,
      outerMessage: ambiguous,
      outerToolCallId,
      details: ambiguous.details,
      persistedActions: new Map(),
      maxVisibleBytes: 100,
    });
    expect(unchanged.status).toBe("unchanged");
    expect(unchanged.message).toBe(ambiguous);
  });
});
