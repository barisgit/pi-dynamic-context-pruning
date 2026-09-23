import type { DcpConfig } from "../../types/config.js";
import type { DcpMessage } from "../../types/message.js";
import type { DcpState, ToolRecord } from "../../types/state.js";
import { estimateTokens } from "../tokens/estimate.js";
import { toolNameMatches } from "./index.js";
import { collectFoRefAdapterCandidates, type FoRefBridgeV1 } from "./fo-ref-adapter.js";

export const JEV_MAX_TASK_TOKENS = 4000;

/** Only public text content, never details, thinking, images or private metadata. */
export function jevText(message: DcpMessage): string | null {
  if (typeof message.content === "string") return message.content;
  if (
    !Array.isArray(message.content) ||
    !message.content.every((p: any) => p?.type === "text" && typeof p.text === "string")
  )
    return null;
  return message.content.map((p: any) => p.text).join("\n");
}

/** Select complete recent public dialogue entries, never private/tool content. */
export function snapshotJevTaskContext(messages: DcpMessage[]): string {
  const parts: string[] = [];
  let tokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    let text = "";
    if (message.role === "user" || message.role === "assistant") {
      const content =
        typeof message.content === "string"
          ? message.content
          : Array.isArray(message.content)
            ? message.content
                .filter((p: any) => p?.type === "text" && typeof p.text === "string")
                .map((p: any) => p.text)
                .join("\n")
            : "";
      if (content) text = `${message.role}: ${content}`;
    } else if (message.role === "compactionSummary" || message.role === "branchSummary") {
      if (typeof message.summary === "string") text = `Older summary: ${message.summary}`;
    }
    if (!text) continue;
    const cost = estimateTokens(text);
    if (tokens + cost > JEV_MAX_TASK_TOKENS) continue;
    tokens += cost;
    parts.unshift(text);
  }
  return (
    "Partial recent public context; omitted history and nontext content may matter. Newer dialogue overrides older summaries.\n\n" +
    parts.join("\n\n")
  );
}

export interface JevCandidate {
  id: string;
  artifact: string;
  toolName: string;
  inputArgs: Record<string, unknown>;
  isError: boolean;
  /** Captured at observation time; exposed inner Refs inherit the outer call turn index. */
  ageTurns: number;
  source: "tool-result" | "fo-ref";
}

/** Pure, bounded remaining-output selection after deterministic rendering. No projections or mutations. */
export function collectJevCandidates(
  messages: DcpMessage[],
  state: DcpState,
  config: DcpConfig,
  bridge?: FoRefBridgeV1 | null,
  onSkip?: (reason: string) => void
): JevCandidate[] {
  const results: JevCandidate[] = [];
  const bucket =
    Math.floor(state.currentTurn / Math.max(1, config.strategies.pruneCadenceTurns)) *
    Math.max(1, config.strategies.pruneCadenceTurns);
  const add = (
    message: DcpMessage,
    record: ToolRecord | undefined,
    source: JevCandidate["source"]
  ) => {
    if (!record) return onSkip?.("missing-record");
    if (state.prunedToolIds.has(record.toolCallId)) return onSkip?.("already-pruned");
    if (
      ["run", "subagent", "workflow", "write", "edit", "compress", "dcp_recover"].includes(
        record.toolName.toLowerCase()
      )
    )
      return onSkip?.("protected-container-or-tool");
    if (
      toolNameMatches(record.toolName, [
        ...config.compress.protectedTools,
        ...config.strategies.deduplication.protectedTools,
        ...config.strategies.candidates.protectedTools,
      ])
    )
      return onSkip?.("protected-tool");
    if (
      Object.values(record.inputArgs).some(
        (v) => typeof v === "string" && toolNameMatches(v, config.protectedFilePatterns)
      )
    )
      return onSkip?.("protected-file");
    if (
      record.turnIndex >= bucket ||
      bucket - record.turnIndex < config.strategies.candidates.minAgeTurns ||
      record.turnIndex >= state.currentTurn - config.compress.protectRecentTurns
    )
      return onSkip?.("age-or-hot-tail");
    const text = jevText(message);
    if (text === null) return onSkip?.("unsupported-content");
    if (!text || estimateTokens(text) < config.strategies.candidates.minResultTokens)
      return onSkip?.("below-minimum-size");
    results.push({
      id: record.toolCallId,
      artifact: text,
      source,
      toolName: record.toolName,
      inputArgs: record.inputArgs,
      isError: !!(record.isError || message.isError),
      ageTurns: state.currentTurn - record.turnIndex,
    });
  };
  for (const message of messages) {
    if (message.role !== "toolResult" && message.role !== "bashExecution") continue;
    const record = state.toolCalls.get(message.toolCallId ?? "");
    add(message, record, "tool-result");
    if (
      !bridge ||
      !record ||
      record.isError ||
      message.isError ||
      jevText(message) === null ||
      record.toolName.toLowerCase() !== "run"
    )
      continue;
    const collection = collectFoRefAdapterCandidates({
      bridge,
      outerToolCallId: record.toolCallId,
      details: message.details,
      outerRecord: record,
    });
    if (collection.status !== "supported") continue;
    collection.messages.forEach((m, i) => {
      const candidate = collection.candidates[i];
      if (
        candidate &&
        !candidate.error &&
        candidate.exposureCount > 0 &&
        candidate.exposureIds.length > 0
      )
        add(m, collection.records[i], "fo-ref");
    });
  }
  return results;
}
