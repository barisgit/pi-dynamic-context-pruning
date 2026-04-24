import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import type { DcpConfig } from "../types/config.js"
import type { DcpState } from "../types/state.js"
import { filterProviderPayloadInput } from "../domain/provider/payload-filter.js"
import { appendDebugLog, buildSessionDebugPayload } from "../infrastructure/debug-log.js"

/** Register provider request adaptation that removes stale hidden payload history. */
export function registerProviderHandler(pi: ExtensionAPI, state: DcpState, config: DcpConfig): void {
  pi.on("before_provider_request", async (event, ctx) => {
    const payload = event.payload as any
    if (!payload || !Array.isArray(payload.input) || state.lastLiveOwnerKeys.length === 0) {
      return
    }

    const filteredInput = filterProviderPayloadInput(
      payload.input,
      state.lastLiveOwnerKeys,
      state.compressionBlocks,
      state.messageOwnerSnapshot,
    )
    if (filteredInput.length === payload.input.length) {
      return
    }

    appendDebugLog(config, "provider_payload_filtered", {
      ...buildSessionDebugPayload(ctx.sessionManager),
      inputCountBefore: payload.input.length,
      inputCountAfter: filteredInput.length,
      liveOwnerCount: state.lastLiveOwnerKeys.length,
    })

    return {
      ...payload,
      input: filteredInput,
    }
  })
}
