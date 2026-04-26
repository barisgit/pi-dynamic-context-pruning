// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) — token estimation helpers
// ---------------------------------------------------------------------------

import { countTokens } from "gpt-tokenizer"

const FALLBACK_CHARS_PER_TOKEN = 4
const IMAGE_TOKEN_ESTIMATE = 500

function estimateTextTokensFallback(text: string): number {
  return Math.round(text.length / FALLBACK_CHARS_PER_TOKEN)
}

/**
 * Estimate text tokens using the OpenAI o200k tokenizer with a safe chars/4 fallback.
 *
 * This is still an estimate: provider payload wrappers, non-OpenAI models, images,
 * and tool-call structure may use different accounting.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0

  try {
    return countTokens(text)
  } catch {
    return estimateTextTokensFallback(text)
  }
}

/** Estimate tokens from a DCP/pi message content shape. */
export function estimateMessageTokens(msg: any): number {
  if (!msg) return 0

  const content = msg.content
  if (!content) return 0
  if (typeof content === "string") return estimateTokens(content)
  if (!Array.isArray(content)) return 0

  let total = 0
  for (const part of content) {
    if (!part || typeof part !== "object") continue
    if (typeof part.text === "string") total += estimateTokens(part.text)
    else if (typeof part.thinking === "string") total += estimateTokens(part.thinking)
    else if (typeof part.input === "string") total += estimateTokens(part.input)
    else if (part.type === "image") total += IMAGE_TOKEN_ESTIMATE
  }

  return total
}
