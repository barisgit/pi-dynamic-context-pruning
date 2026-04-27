import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { DcpConfig } from "../types/config.js";
import type { DcpState } from "../types/state.js";
import { resetState } from "../state.js";
import { appendDebugLog, buildSessionDebugPayload } from "../infrastructure/debug-log.js";
import { restorePersistedState, serializePersistedState } from "../infrastructure/persistence.js";
import { updateDcpStatus } from "./status.js";

/** Apply config-derived baseline state before session hooks run. */
export function initializeSessionState(state: DcpState, config: DcpConfig): void {
  if (config.manualMode.enabled) {
    state.manualMode = true;
  }
}

/** Persist the current DCP runtime state as a custom session entry. */
export function saveState(
  pi: ExtensionAPI,
  state: DcpState,
  config: DcpConfig,
  reason: "session_shutdown" | "agent_end",
  sessionPayload: Record<string, unknown>
): void {
  pi.appendEntry("dcp-state", serializePersistedState(state));
  appendDebugLog(config, "state_saved", {
    ...sessionPayload,
    reason,
    manualMode: state.manualMode,
    activeCompressionBlockCount: state.compressionBlocks.filter((block) => block.active).length,
    nextBlockId: state.nextBlockId,
    totalPruneCount: state.totalPruneCount,
    tokensSaved: state.tokensSaved,
  });
}

/** Register DCP session lifecycle persistence handlers. */
export function registerSessionHandlers(
  pi: ExtensionAPI,
  state: DcpState,
  config: DcpConfig
): void {
  pi.on("session_start", async (_event, ctx) => {
    resetState(state);
    initializeSessionState(state, config);

    const branchEntries = ctx.sessionManager.getBranch();
    let restoredStateEntries = 0;
    for (const entry of branchEntries) {
      if (entry.type === "custom" && entry.customType === "dcp-state") {
        restorePersistedState(entry.data, state);
        restoredStateEntries++;
      }
    }

    appendDebugLog(config, "session_start", {
      ...buildSessionDebugPayload(ctx.sessionManager),
      branchEntryCount: branchEntries.length,
      restoredStateEntries,
      manualMode: state.manualMode,
      activeCompressionBlockCount: state.compressionBlocks.filter((block) => block.active).length,
      nextBlockId: state.nextBlockId,
    });

    if (ctx.hasUI) updateDcpStatus(ctx, state);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    saveState(pi, state, config, "session_shutdown", buildSessionDebugPayload(ctx.sessionManager));
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    saveState(pi, state, config, "agent_end", buildSessionDebugPayload(ctx.sessionManager));
  });
}
