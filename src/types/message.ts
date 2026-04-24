// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) — internal message boundary types
// ---------------------------------------------------------------------------

export interface DcpTextPart {
  type?: "text" | string
  text: string
  [key: string]: unknown
}

export interface DcpThinkingPart {
  type?: "thinking" | string
  thinking: string
  [key: string]: unknown
}

export interface DcpImagePart {
  type: "image"
  [key: string]: unknown
}

export interface DcpToolCallPart {
  type: "toolCall" | "tool_use" | string
  id?: string
  name?: string
  input?: unknown
  arguments?: unknown
  [key: string]: unknown
}

export type DcpContentPart =
  | DcpTextPart
  | DcpThinkingPart
  | DcpImagePart
  | DcpToolCallPart
  | Record<string, unknown>

export type DcpMessageContent = string | DcpContentPart[]

/**
 * Minimal normalized message shape used by DCP domain logic.
 *
 * Pi/provider payloads remain heterogeneous at the application boundary; this
 * type captures only the fields DCP needs while allowing additional host fields
 * to pass through unchanged.
 */
export interface DcpMessage {
  role?: string
  content?: any
  timestamp?: number
  id?: string
  messageId?: string
  entryId?: string
  toolCallId?: string
  toolName?: string
  isError?: boolean
  [key: string]: any
}

export interface DcpToolResultMessage extends DcpMessage {
  role: "toolResult" | "bashExecution"
  toolCallId: string
  toolName?: string
}

export interface DcpAssistantMessage extends DcpMessage {
  role: "assistant"
  content?: DcpMessageContent
}

export function isDcpContentPart(value: unknown): value is DcpContentPart {
  return typeof value === "object" && value !== null
}
