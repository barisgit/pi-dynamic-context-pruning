// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) — PI extension entry point
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./application/commands/dcp.ts";
import { registerCompressTool } from "./application/compress-tool/registration.ts";
import { registerContextHandler } from "./application/context-handler.ts";
import { registerDcpNativeCompactionBridge } from "./application/native-compaction.ts";
import { registerProviderHandler } from "./application/provider-handler.ts";
import { initializeSessionState, registerSessionHandlers } from "./application/session-handler.ts";
import { registerSystemPromptHandler } from "./application/system-prompt-handler.ts";
import { registerToolRecordingHandlers } from "./application/tool-recording.ts";
import { loadConfig } from "./infrastructure/config.ts";
import { appendDebugLog, DEBUG_LOG_PATH } from "./infrastructure/debug-log.ts";
import { createState } from "./state.ts";

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
  const config = loadConfig(process.cwd());
  if (!config.enabled) return;

  appendDebugLog(config, "extension_init", {
    cwd: process.cwd(),
    debugLogPath: DEBUG_LOG_PATH,
    protectRecentTurns: config.compress.protectRecentTurns,
    pruneNotification: config.pruneNotification,
  });

  const state = createState();
  initializeSessionState(state, config);

  registerCompressTool(pi, state, config);
  registerCommands(pi, state, config);
  registerSessionHandlers(pi, state, config);
  registerDcpNativeCompactionBridge(pi, state, config);
  registerSystemPromptHandler(pi, state);
  registerToolRecordingHandlers(pi, state);
  registerContextHandler(pi, state, config);
  registerProviderHandler(pi, state, config);
}
