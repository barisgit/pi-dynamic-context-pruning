import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import type { DcpState } from "../types/state.js"
import { MANUAL_MODE_SYSTEM_PROMPT, SYSTEM_PROMPT } from "../prompts/system.js"

/** Register system prompt augmentation for automatic/manual DCP modes. */
export function registerSystemPromptHandler(pi: ExtensionAPI, state: DcpState): void {
  pi.on("before_agent_start", async (event, _ctx) => {
    const promptAddition = state.manualMode ? MANUAL_MODE_SYSTEM_PROMPT : SYSTEM_PROMPT

    return {
      systemPrompt: event.systemPrompt + "\n\n" + promptAddition,
    }
  })
}
