import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { DcpState } from "../types/state.js";
import type { DcpMessage } from "../types/message.js";
import { createInputFingerprint } from "../state.js";
import { estimateTokens } from "../domain/tokens/estimate.js";
import { buildTranscriptSnapshot } from "../domain/transcript/index.js";

const LOGICAL_TURN_ROLES = new Set(["user", "assistant", "toolResult", "bashExecution"]);

function extractResultText(message: any): string {
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content
      .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
      .join("");
  }
  return typeof message?.output === "string" ? message.output : "";
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Reconstruct missing tool records from the source transcript after resume.
 * Live event records win; this only fills calls that cannot fire tool events
 * again because their assistant/result exchange predates the current process.
 */
export function hydrateMissingToolRecords(messages: DcpMessage[], state: DcpState): void {
  const snapshot = buildTranscriptSnapshot(messages);
  const turnIndexBySourceKey = new Map<string, number>();
  let turnIndex = 0;
  for (const span of snapshot.spans) {
    if (!LOGICAL_TURN_ROLES.has(span.role)) continue;
    for (const sourceKey of span.sourceKeys) turnIndexBySourceKey.set(sourceKey, turnIndex);
    turnIndex++;
  }

  const calls = new Map<string, { toolName: string; inputArgs: Record<string, unknown> }>();
  for (const item of snapshot.sourceItems) {
    if (item.role !== "assistant" || !Array.isArray(item.message?.content)) continue;
    for (const block of item.message.content as any[]) {
      if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
      const toolName = typeof block.name === "string" ? block.name : "";
      const inputArgs = parseToolArguments(block.arguments ?? block.input);
      calls.set(block.id, { toolName, inputArgs });
    }
  }

  for (const item of snapshot.sourceItems) {
    if (item.role !== "toolResult" && item.role !== "bashExecution") continue;
    const message = item.message as any;
    if (typeof message.toolCallId !== "string" || state.toolCalls.has(message.toolCallId)) continue;

    const call = calls.get(message.toolCallId);
    const toolName =
      call?.toolName ||
      (typeof message.toolName === "string"
        ? message.toolName
        : item.role === "bashExecution"
          ? "bash"
          : "");
    const inputArgs =
      call?.inputArgs ??
      (item.role === "bashExecution" && typeof message.command === "string"
        ? { command: message.command }
        : {});

    state.toolCalls.set(message.toolCallId, {
      toolCallId: message.toolCallId,
      toolName,
      inputArgs,
      inputFingerprint: createInputFingerprint(toolName, inputArgs),
      isError: message.isError === true,
      turnIndex: turnIndexBySourceKey.get(item.key) ?? 0,
      timestamp:
        typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
          ? message.timestamp
          : 0,
      tokenEstimate: estimateTokens(extractResultText(message)),
    });
  }
}

/** Register tool call/result bookkeeping used by deduplication and error purging. */
export function registerToolRecordingHandlers(pi: ExtensionAPI, state: DcpState): void {
  pi.on("tool_call", async (event, _ctx) => {
    if (!state.toolCalls.has(event.toolCallId)) {
      state.toolCalls.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        inputArgs: event.input as Record<string, unknown>,
        inputFingerprint: createInputFingerprint(
          event.toolName,
          event.input as Record<string, unknown>
        ),
        isError: false,
        turnIndex: state.currentTurn,
        timestamp: 0,
        tokenEstimate: 0,
      });
    }
  });

  pi.on("tool_result", async (event, _ctx) => {
    const record = state.toolCalls.get(event.toolCallId);
    const outputText = event.content
      .map((contentPart: any) => (contentPart.type === "text" ? contentPart.text : ""))
      .join("");
    const tokenEstimate = estimateTokens(outputText);

    if (record) {
      record.isError = event.isError;
      record.timestamp = Date.now();
      record.tokenEstimate = tokenEstimate;
      return;
    }

    state.toolCalls.set(event.toolCallId, {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      inputArgs: {},
      inputFingerprint: createInputFingerprint(event.toolName, {}),
      isError: event.isError,
      turnIndex: state.currentTurn,
      timestamp: Date.now(),
      tokenEstimate,
    });
  });
}
