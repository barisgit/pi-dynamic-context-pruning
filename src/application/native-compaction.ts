import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { reconcileCompactedBlocks } from "./compaction-state.ts";
import type { DcpConfig } from "../types/config.ts";
import type { DcpState } from "../types/state.ts";
import { appendDebugLog, buildSessionDebugPayload } from "../infrastructure/debug-log.ts";
import { saveState } from "./session-handler.ts";
import { updateDcpStatus } from "./status.ts";

/** Pi alone summarizes; only a committed compaction mutates DCP state. */
export function registerDcpNativeCompactionBridge(
  pi: ExtensionAPI,
  state: DcpState,
  config: DcpConfig
): void {
  pi.on("session_compact", async (event, ctx) => {
    const branch = ctx.sessionManager.getBranch();
    const retiredBlockIds = reconcileCompactedBlocks(state, branch, event.compactionEntry.id);
    state.lastCompressTurn = -1;
    state.lastNudgeTurn = -1;
    state.pendingSave = true;
    appendDebugLog(config, "native_compaction_committed", {
      ...buildSessionDebugPayload(ctx.sessionManager),
      retiredBlockIds,
      firstKeptEntryId: event.compactionEntry.firstKeptEntryId,
      remainingActiveCompressionBlockCount: state.compressionBlocks.filter((b) => b.active).length,
      tokensSavedAfter: state.tokensSaved,
    });
    if (ctx.hasUI) updateDcpStatus(ctx, state);
    saveState(pi, state, config, "native_compaction", buildSessionDebugPayload(ctx.sessionManager));
  });
}
