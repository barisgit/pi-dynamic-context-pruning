// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) — PI extension entry point
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { registerCommands } from "./application/commands/dcp.js"
import { registerCompressTool } from "./application/compress-tool/registration.js"
import { registerContextHandler } from "./application/context-handler.js"
import { registerProviderHandler } from "./application/provider-handler.js"
import { initializeSessionState, registerSessionHandlers } from "./application/session-handler.js"
import { registerSystemPromptHandler } from "./application/system-prompt-handler.js"
import { registerToolRecordingHandlers } from "./application/tool-recording.js"
import { loadConfig } from "./infrastructure/config.js"
import { appendDebugLog, DEBUG_LOG_PATH } from "./infrastructure/debug-log.js"
import { createState } from "./state.js"

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
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

  const state = createState()
  initializeSessionState(state, config)

  registerCompressTool(pi, state, config)
  registerCommands(pi, state, config)
  registerSessionHandlers(pi, state, config)
  registerSystemPromptHandler(pi, state)
  registerToolRecordingHandlers(pi, state)
  registerContextHandler(pi, state, config)
  registerProviderHandler(pi, state, config)
}
