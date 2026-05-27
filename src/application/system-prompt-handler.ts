import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import type { DcpState } from "../types/state.js"
import { SYSTEM_PROMPT } from "../prompts/system.js"

/** Register system prompt augmentation for DCP. */
export function registerSystemPromptHandler(pi: ExtensionAPI, _state: DcpState): void {
  pi.on("before_agent_start", async (event, _ctx) => {
    return {
      systemPrompt: event.systemPrompt + "\n\n" + SYSTEM_PROMPT,
    }
  })
}
