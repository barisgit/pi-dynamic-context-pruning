import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { DcpConfig } from "../types/config.js"

// ---------------------------------------------------------------------------
// Debug log
// ---------------------------------------------------------------------------

export const DEBUG_LOG_PATH = path.join(os.homedir(), ".pi", "log", "dcp.jsonl")

export interface DebugLogPayload {
  [key: string]: unknown
}

export interface DebugSessionSource {
  getCwd(): string
  getSessionDir(): string
  getSessionFile(): string | undefined
  getSessionId(): string
  getLeafId(): string | null
}

interface DebugLogEntry {
  timestamp: string
  event: string
  payload: DebugLogPayload
}

function normalizeDebugValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    }
  }

  if (value instanceof Set) {
    return Array.from(value, (item) => normalizeDebugValue(item))
  }

  if (value instanceof Map) {
    return Array.from(value.entries(), ([key, mapValue]) => [key, normalizeDebugValue(mapValue)])
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeDebugValue(item))
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => [
        key,
        normalizeDebugValue(nestedValue),
      ]),
    )
  }

  if (typeof value === "number" && !Number.isFinite(value)) {
    return String(value)
  }

  return value
}

/**
 * Build stable session metadata for debug log payloads.
 */
export function buildSessionDebugPayload(sessionManager: DebugSessionSource): DebugLogPayload {
  return {
    sessionId: sessionManager.getSessionId(),
    cwd: sessionManager.getCwd(),
    sessionDir: sessionManager.getSessionDir(),
    sessionFile: sessionManager.getSessionFile() ?? null,
    leafId: sessionManager.getLeafId(),
  }
}

/**
 * Append a best-effort JSONL debug event to an explicit file path.
 */
export function appendDebugLogLine(
  filePath: string,
  event: string,
  payload: DebugLogPayload = {},
): void {
  const entry: DebugLogEntry = {
    timestamp: new Date().toISOString(),
    event,
    payload: normalizeDebugValue(payload) as DebugLogPayload,
  }

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8")
  } catch {
    // Best-effort only. Debug logging must never affect runtime behavior.
  }
}

/**
 * Append a best-effort JSONL debug event to the DCP debug log.
 */
export function appendDebugLog(
  config: DcpConfig,
  event: string,
  payload: DebugLogPayload = {},
): void {
  if (!config.debug) return
  appendDebugLogLine(DEBUG_LOG_PATH, event, payload)
}
