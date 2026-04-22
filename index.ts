// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) — PI extension entry point
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { loadConfig } from "./config.js"
import {
  createState,
  resetState,
  createInputFingerprint,
  type DcpState,
} from "./state.js"
import {
  SYSTEM_PROMPT,
  MANUAL_MODE_SYSTEM_PROMPT,
  CONTEXT_LIMIT_NUDGE_STRONG,
  CONTEXT_LIMIT_NUDGE_SOFT,
  TURN_NUDGE,
  ITERATION_NUDGE,
} from "./prompts.js"
import { applyPruning, injectNudge, getNudgeType } from "./pruner.js"
import { registerCompressTool } from "./compress-tool.js"
import { registerCommands } from "./commands.js"
import { restorePersistedState, serializePersistedState } from "./migration.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Persist the current DCP runtime state as a custom session entry so it
 * survives session restarts and pi process restarts.
 */
function saveState(pi: ExtensionAPI, state: DcpState): void {
  pi.appendEntry("dcp-state", serializePersistedState(state))
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // ── 1. Load config ────────────────────────────────────────────────────────
  const config = loadConfig(process.cwd())

  if (!config.enabled) return

  // ── 2. Create state ───────────────────────────────────────────────────────
  const state = createState()

  // Apply config baseline for manual mode before any session events fire.
  if (config.manualMode.enabled) {
    state.manualMode = true
  }

  // ── 3. Register compress tool ─────────────────────────────────────────────
  registerCompressTool(pi, state, config)

  // ── 4. Register /dcp commands ─────────────────────────────────────────────
  registerCommands(pi, state, config)

  // ── 5. session_start: restore state from session entries ──────────────────
  pi.on("session_start", async (event, ctx) => {
    // Reset to a clean slate first.
    resetState(state)

    // Re-apply config baseline so manual mode survives a session_start reset.
    if (config.manualMode.enabled) {
      state.manualMode = true
    }

    // Walk the branch looking for the most-recent persisted dcp-state entry.
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "dcp-state") {
        restorePersistedState(entry.data, state)
      }
    }

    // Show a status indicator in the pi TUI.
    ctx.ui.setStatus("dcp", state.manualMode ? "DCP [manual]" : "DCP")
  })

  // ── 6. session_shutdown: save state ───────────────────────────────────────
  pi.on("session_shutdown", async (_event, _ctx) => {
    saveState(pi, state)
  })

  // ── 7. before_agent_start: inject system prompt ───────────────────────────
  pi.on("before_agent_start", async (event, _ctx) => {
    const promptAddition = state.manualMode
      ? MANUAL_MODE_SYSTEM_PROMPT
      : SYSTEM_PROMPT

    return {
      systemPrompt: event.systemPrompt + "\n\n" + promptAddition,
    }
  })

  // ── 8. tool_call: record input args for dedup / purge fingerprinting ───────
  pi.on("tool_call", async (event, _ctx) => {
    // Only create a record if we haven't seen this toolCallId yet.  The
    // tool_result handler may also create one if the tool_call event was
    // somehow missed.
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
        timestamp: 0, // filled in by the tool_result handler
        tokenEstimate: 0,
      })
    }
  })

  // ── 9. tool_result: finalise tool record with result info ─────────────────
  pi.on("tool_result", async (event, _ctx) => {
    const record = state.toolCalls.get(event.toolCallId)

    const outputText = event.content
      .map((c: any) => (c.type === "text" ? c.text : ""))
      .join("")
    const tokenEstimate = Math.round(outputText.length / 4)

    if (record) {
      // Update the record created in tool_call.
      record.isError = event.isError
      record.timestamp = Date.now()
      record.tokenEstimate = tokenEstimate
    } else {
      // Fallback: create a record even when tool_call event was not observed.
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
    }
  })

  // ── 10. context: apply pruning and inject nudges ──────────────────────────
  pi.on("context", async (event, ctx) => {
    // Apply all pruning transforms (compression blocks, dedup, error purge,
    // tool output replacement, message ID injection).
    const prunedMessages = applyPruning(event.messages, state, config)

    // In manual mode we still apply pruning strategies (if
    // automaticStrategies is on) but skip autonomous nudge injection.
    const usage = ctx.getContextUsage()
    if (usage && usage.tokens !== null && !state.manualMode) {
      const contextPercent = usage.tokens / usage.contextWindow

      // Count tool calls since the last user message (used for iteration nudge).
      let toolCallsSinceLastUser = 0
      for (let i = prunedMessages.length - 1; i >= 0; i--) {
        const msg = prunedMessages[i] as any
        if (msg.role === "user") break
        if (msg.role === "toolResult" || msg.role === "bashExecution") {
          toolCallsSinceLastUser++
        }
      }

      const nudgeType = getNudgeType(
        contextPercent,
        state,
        config,
        toolCallsSinceLastUser,
      )

      if (nudgeType) {
        let nudgeText: string

        if (nudgeType === "context-strong") {
          nudgeText = CONTEXT_LIMIT_NUDGE_STRONG
        } else if (nudgeType === "context-soft") {
          nudgeText = CONTEXT_LIMIT_NUDGE_SOFT
        } else if (nudgeType === "iteration") {
          nudgeText = ITERATION_NUDGE
        } else {
          // "turn"
          nudgeText = TURN_NUDGE
        }

        injectNudge(prunedMessages, nudgeText)
        state.lastNudgeTurn = state.currentTurn
      }
    }

    return { messages: prunedMessages }
  })

  // ── 11. agent_end: persist state after each agent run ────────────────────
  pi.on("agent_end", async (_event, _ctx) => {
    saveState(pi, state)
  })
}
