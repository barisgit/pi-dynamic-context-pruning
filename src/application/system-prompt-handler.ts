import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DcpState } from "../types/state.ts";
import { SYSTEM_PROMPT } from "../prompts/system.ts";

/** Register system prompt augmentation for DCP. */
export function registerSystemPromptHandler(pi: ExtensionAPI, _state: DcpState): void {
  pi.on("before_agent_start", async (event, _ctx) => {
    return {
      systemPrompt: event.systemPrompt + "\n\n" + SYSTEM_PROMPT,
    };
  });
}
