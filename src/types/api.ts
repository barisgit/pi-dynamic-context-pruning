// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) — host/provider boundary types
// ---------------------------------------------------------------------------

import type { DcpMessage } from "./message.js"

export interface DcpContextEvent {
  messages?: DcpMessage[]
  contextWindow?: number
  tokenCount?: number
  [key: string]: unknown
}

export type DcpProviderPayloadItem = Record<string, any>

export interface DcpProviderRequestPayload {
  input?: DcpProviderPayloadItem[]
  messages?: DcpProviderPayloadItem[]
  [key: string]: unknown
}

export interface DcpToolCallEvent {
  toolCallId?: string
  toolName?: string
  name?: string
  args?: Record<string, unknown>
  arguments?: Record<string, unknown>
  [key: string]: unknown
}

export interface DcpToolResultEvent {
  toolCallId?: string
  toolName?: string
  name?: string
  isError?: boolean
  content?: unknown
  result?: unknown
  timestamp?: number
  [key: string]: unknown
}

export interface DcpSessionMetadataProvider {
  getSessionId?: () => string | undefined
  getCwd?: () => string | undefined
  getSessionDir?: () => string | undefined
  getSessionFile?: () => string | undefined
  getLeafId?: () => string | undefined
}
