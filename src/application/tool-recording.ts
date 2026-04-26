import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import type { DcpState } from "../types/state.js"
import { createInputFingerprint } from "../state.js"
import { estimateTokens } from "../domain/tokens/estimate.js"

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
          event.input as Record<string, unknown>,
        ),
        isError: false,
        turnIndex: state.currentTurn,
        timestamp: 0,
        tokenEstimate: 0,
      })
    }
  })

  pi.on("tool_result", async (event, _ctx) => {
    const record = state.toolCalls.get(event.toolCallId)
    const outputText = event.content
      .map((contentPart: any) => (contentPart.type === "text" ? contentPart.text : ""))
      .join("")
    const tokenEstimate = estimateTokens(outputText)

    if (record) {
      record.isError = event.isError
      record.timestamp = Date.now()
      record.tokenEstimate = tokenEstimate
      return
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
    })
  })
}
