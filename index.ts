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
import {
  buildCompressionPlanningHints,
  registerCompressTool,
  renderCompressionPlanningHints,
} from "./compress-tool.js"
import { registerCommands } from "./commands.js"
import { DEBUG_LOG_PATH, appendDebugLog, buildSessionDebugPayload } from "./debug-log.js"
import { restorePersistedState, serializePersistedState } from "./migration.js"
import { filterProviderPayloadInput } from "./payload-filter.js"
import { buildLiveOwnerKeys } from "./transcript.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Persist the current DCP runtime state as a custom session entry so it
 * survives session restarts and pi process restarts.
 */
function saveState(
  pi: ExtensionAPI,
  state: DcpState,
  config: ReturnType<typeof loadConfig>,
  reason: "session_shutdown" | "agent_end",
  sessionPayload: Record<string, unknown>,
): void {
  pi.appendEntry("dcp-state", serializePersistedState(state))
  appendDebugLog(config, "state_saved", {
    ...sessionPayload,
    reason,
    manualMode: state.manualMode,
    activeCompressionBlockCount: state.compressionBlocks.filter((block) => block.active).length,
    nextBlockId: state.nextBlockId,
    totalPruneCount: state.totalPruneCount,
    tokensSaved: state.tokensSaved,
  })
}

function cloneRenderedMessages(messages: any[]): any[] {
  return messages.map((message) => {
    const clone = { ...message }
    if (Array.isArray(clone.content)) {
      clone.content = clone.content.map((part: any) =>
        typeof part === "object" && part !== null ? { ...part } : part,
      )
    }
    return clone
  })
}

function appendReminderDetails(reminder: string, details: string): string {
  if (!details) return reminder

  const closingTag = "</dcp-system-reminder>"
  if (!reminder.includes(closingTag)) {
    return `${reminder}\n\n${details}`
  }

  return reminder.replace(closingTag, `\n\n${details}\n${closingTag}`)
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // ── 1. Load config ────────────────────────────────────────────────────────
  const config = loadConfig(process.cwd())

  if (!config.enabled) return

  appendDebugLog(config, "extension_init", {
    cwd: process.cwd(),
    debugLogPath: DEBUG_LOG_PATH,
    manualModeConfigured: config.manualMode.enabled,
    automaticStrategiesInManualMode: config.manualMode.automaticStrategies,
    protectRecentTurns: config.compress.protectRecentTurns,
    pruneNotification: config.pruneNotification,
  })

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
  pi.on("session_start", async (_event, ctx) => {
    // Reset to a clean slate first.
    resetState(state)

    // Re-apply config baseline so manual mode survives a session_start reset.
    if (config.manualMode.enabled) {
      state.manualMode = true
    }

    // Walk the branch looking for the most-recent persisted dcp-state entry.
    const branchEntries = ctx.sessionManager.getBranch()
    let restoredStateEntries = 0
    for (const entry of branchEntries) {
      if (entry.type === "custom" && entry.customType === "dcp-state") {
        restorePersistedState(entry.data, state)
        restoredStateEntries++
      }
    }

    appendDebugLog(config, "session_start", {
      ...buildSessionDebugPayload(ctx.sessionManager),
      branchEntryCount: branchEntries.length,
      restoredStateEntries,
      manualMode: state.manualMode,
      activeCompressionBlockCount: state.compressionBlocks.filter((block) => block.active).length,
      nextBlockId: state.nextBlockId,
    })

    // Show a status indicator in the pi TUI.
    ctx.ui.setStatus("dcp", state.manualMode ? "DCP [manual]" : "DCP")
  })

  // ── 6. session_shutdown: save state ───────────────────────────────────────
  pi.on("session_shutdown", async (_event, ctx) => {
    saveState(
      pi,
      state,
      config,
      "session_shutdown",
      buildSessionDebugPayload(ctx.sessionManager),
    )
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
    const liveOwnerKeys = buildLiveOwnerKeys(event.messages, state.compressionBlocks)

    // Apply all pruning transforms (compression blocks, dedup, error purge,
    // tool output replacement, message ID injection).
    const prunedMessages = applyPruning(event.messages, state, config)

    const usage = ctx.getContextUsage()
    const contextPercent = usage && usage.tokens !== null ? usage.tokens / usage.contextWindow : null
    let toolCallsSinceLastUser: number | null = null
    let nudgeType: ReturnType<typeof getNudgeType> = null

    // In manual mode we still apply pruning strategies (if
    // automaticStrategies is on) but skip autonomous nudge injection.
    if (contextPercent !== null && !state.manualMode) {
      // Count tool calls since the last user message (used for iteration nudge).
      toolCallsSinceLastUser = 0
      for (let i = prunedMessages.length - 1; i >= 0; i--) {
        const msg = prunedMessages[i] as any
        if (msg.role === "user") break
        if (msg.role === "toolResult" || msg.role === "bashExecution") {
          toolCallsSinceLastUser++
        }
      }

      nudgeType = getNudgeType(
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

        const planningHints = buildCompressionPlanningHints(
          event.messages,
          state,
          config.compress.protectRecentTurns,
        )
        const planningHintText = renderCompressionPlanningHints(planningHints)
        const injectedNudgeText = appendReminderDetails(nudgeText, planningHintText)

        injectNudge(prunedMessages, injectedNudgeText)
        state.lastNudgeTurn = state.currentTurn

        appendDebugLog(config, "nudge_emitted", {
          ...buildSessionDebugPayload(ctx.sessionManager),
          nudgeType,
          nudgeMessage: injectedNudgeText,
          contextPercent,
          currentTurn: state.currentTurn,
          toolCallsSinceLastUser,
          planningHints,
        })
      }
    }

    state.lastRenderedMessages = cloneRenderedMessages(prunedMessages)
    state.lastLiveOwnerKeys = Array.from(liveOwnerKeys)

    appendDebugLog(config, "context_evaluated", {
      ...buildSessionDebugPayload(ctx.sessionManager),
      contextTokens: usage?.tokens ?? null,
      contextWindow: usage?.contextWindow ?? null,
      contextPercent,
      currentTurn: state.currentTurn,
      manualMode: state.manualMode,
      sourceMessageCount: event.messages.length,
      renderedMessageCount: prunedMessages.length,
      liveOwnerCount: liveOwnerKeys.size,
      activeCompressionBlockCount: state.compressionBlocks.filter((block) => block.active).length,
      tokensSaved: state.tokensSaved,
      totalPruneCount: state.totalPruneCount,
      toolCallsSinceLastUser,
      nudgeType,
    })

    return { messages: prunedMessages }
  })

  // ── 11. before_provider_request: filter stale payload history ─────────────
  pi.on("before_provider_request", async (event, _ctx) => {
    const payload = event.payload as any
    if (!payload || !Array.isArray(payload.input) || state.lastLiveOwnerKeys.length === 0) {
      return
    }

    const filteredInput = filterProviderPayloadInput(
      payload.input,
      state.lastLiveOwnerKeys,
      state.compressionBlocks,
    )
    if (filteredInput.length === payload.input.length) {
      return
    }

    appendDebugLog(config, "provider_payload_filtered", {
      ...buildSessionDebugPayload(_ctx.sessionManager),
      inputCountBefore: payload.input.length,
      inputCountAfter: filteredInput.length,
      liveOwnerCount: state.lastLiveOwnerKeys.length,
    })

    return {
      ...payload,
      input: filteredInput,
    }
  })

  // ── 12. agent_end: persist state after each agent run ────────────────────
  pi.on("agent_end", async (_event, ctx) => {
    saveState(
      pi,
      state,
      config,
      "agent_end",
      buildSessionDebugPayload(ctx.sessionManager),
    )
  })
}
