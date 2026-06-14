import * as os from "node:os";
import * as path from "node:path";
import { createLogger } from "pi-extension-utils";
import type { Logger } from "pi-extension-utils";
import type { DcpConfig } from "../types/config.js";

// ---------------------------------------------------------------------------
// Debug log
// ---------------------------------------------------------------------------

export const DEBUG_LOG_PATH = path.join(os.homedir(), ".pi", "log", "dcp.jsonl");

export interface DebugLogPayload {
  [key: string]: unknown;
}

export interface DebugSessionSource {
  getCwd(): string;
  getSessionDir(): string;
  getSessionFile(): string | undefined;
  getSessionId(): string;
  getLeafId(): string | null;
}

let debugLogger: Logger | null | undefined;

function getDebugLogger(): Logger | null {
  if (debugLogger !== undefined) return debugLogger;

  try {
    debugLogger = createLogger("dcp", {
      dir: path.dirname(DEBUG_LOG_PATH),
      level: "debug",
    });
  } catch {
    debugLogger = null;
  }

  return debugLogger;
}

function normalizeDebugValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (value instanceof Set) {
    return Array.from(value, (item) => normalizeDebugValue(item));
  }

  if (value instanceof Map) {
    return Array.from(value.entries(), ([key, mapValue]) => [key, normalizeDebugValue(mapValue)]);
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeDebugValue(item));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => [
        key,
        normalizeDebugValue(nestedValue),
      ])
    );
  }

  if (typeof value === "number" && !Number.isFinite(value)) {
    return String(value);
  }

  return value;
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
  };
}

/**
 * Write a DCP debug event through pi-extension-utils' JSONL logger.
 */
export function appendDebugLog(
  config: DcpConfig,
  event: string,
  payload: DebugLogPayload = {}
): void {
  if (!config.debug) return;

  try {
    getDebugLogger()?.debug(event, {
      timestamp: new Date().toISOString(),
      event,
      payload: normalizeDebugValue(payload) as DebugLogPayload,
    });
  } catch {
    // Best-effort only. Debug logging must never affect runtime behavior.
  }
}
