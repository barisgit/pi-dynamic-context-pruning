import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DcpConfig } from "../types/config.ts";
import type { DcpState } from "../types/state.ts";
import {
  collectSandboxCompressCallAliases,
  filterProviderPayloadInput,
} from "../domain/provider/payload-filter.ts";
import { appendDebugLog, buildSessionDebugPayload } from "../infrastructure/debug-log.ts";

/** Register provider request adaptation that removes stale hidden payload history. */
export function registerProviderHandler(
  pi: ExtensionAPI,
  state: DcpState,
  config: DcpConfig
): void {
  pi.on("before_provider_request", async (event, ctx) => {
    const payload = event.payload as any;
    if (!payload || !Array.isArray(payload.input) || state.lastLiveOwnerKeys.length === 0) {
      return;
    }

    const sandboxCompressCallAliases = collectSandboxCompressCallAliases(
      state.lastRenderedMessages
    );
    const filteredInput = filterProviderPayloadInput(
      payload.input,
      state.lastLiveOwnerKeys,
      state.compressionBlocks,
      state.messageOwnerSnapshot,
      sandboxCompressCallAliases
    );
    const payloadChanged =
      filteredInput.length !== payload.input.length ||
      filteredInput.some((item, index) => item !== payload.input[index]);
    if (!payloadChanged) {
      return;
    }

    appendDebugLog(config, "provider_payload_filtered", {
      ...buildSessionDebugPayload(ctx.sessionManager),
      inputCountBefore: payload.input.length,
      inputCountAfter: filteredInput.length,
      liveOwnerCount: state.lastLiveOwnerKeys.length,
      sandboxCompressCallAliasCount: sandboxCompressCallAliases.length,
    });

    return {
      ...payload,
      input: filteredInput,
    };
  });
}
