import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import type { DcpConfig } from "../types/config.js";

export type { DcpConfig } from "../types/config.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: DcpConfig = {
  enabled: true,
  debug: false,
  manualMode: {
    enabled: false,
    automaticStrategies: true,
  },
  compress: {
    maxContextPercent: 0.9,
    minContextPercent: 0.75,
    nudgeDebounceTurns: 2,
    nudgeFrequency: 8,
    iterationNudgeThreshold: 15,
    protectRecentTurns: 4,
    renderFullBlockCount: 2,
    renderCompactBlockCount: 3,
    nudgeForce: "soft",
    protectedTools: ["compress", "write", "edit"],
    protectUserMessages: false,
  },
  strategies: {
    deduplication: {
      enabled: true,
      protectedTools: [],
    },
    purgeErrors: {
      enabled: true,
      turns: 4,
      protectedTools: [],
    },
  },
  protectedFilePatterns: [],
  pruneNotification: "detailed",
};

const DEFAULT_CONFIG_FILE_CONTENT = `{
  // Dynamic Context Pruning (DCP) configuration
  // Full schema reference: https://github.com/your-org/pi-dynamic-context-pruning
  //
  // "$schema": "...",
  //
  // Uncomment and edit properties you want to override:
  //
  // "enabled": true,
  // "debug": false, // best-effort JSONL log at ~/.pi/log/dcp.jsonl
  // "manualMode": {
  //   "enabled": false,
  //   "automaticStrategies": true
  // },
  // "compress": {
  //   "maxContextPercent": 0.9,
  //   "minContextPercent": 0.75,
  //   // Optional absolute-token thresholds. These are ORed with percent thresholds.
  //   // Useful for large context windows that degrade before they are nearly full.
  //   // "maxContextTokens": 200000,
  //   // "minContextTokens": 150000,
  //   "nudgeDebounceTurns": 2,
  //   "nudgeFrequency": 8,
  //   "iterationNudgeThreshold": 15,
  //   "protectRecentTurns": 4,
  //   "renderFullBlockCount": 2,
  //   "renderCompactBlockCount": 3,
  //   "nudgeForce": "soft",
  //   "protectedTools": ["compress", "write", "edit"],
  //   "protectUserMessages": false
  // },
  // "strategies": {
  //   "deduplication": { "enabled": true, "protectedTools": [] },
  //   "purgeErrors": { "enabled": true, "turns": 4, "protectedTools": [] }
  // },
  // "protectedFilePatterns": [],
  // "pruneNotification": "detailed"
}
`;

const PREFERRED_GLOBAL_CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "dcp.jsonc");
const LEGACY_GLOBAL_CONFIG_PATH = path.join(os.homedir(), ".config", "pi", "dcp.jsonc");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively merge `override` into `base`. Arrays are union-merged (deduped).
 * Returns a new object; does not mutate inputs.
 */
function deepMerge<T>(base: T, override: Partial<T>): T {
  if (override === null || override === undefined) return base;
  if (typeof base !== "object" || typeof override !== "object") {
    return override as T;
  }

  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };

  for (const key of Object.keys(override as Record<string, unknown>)) {
    const baseVal = (base as Record<string, unknown>)[key];
    const overVal = (override as Record<string, unknown>)[key];

    if (Array.isArray(baseVal) && Array.isArray(overVal)) {
      // Union merge: combine and deduplicate by value
      const combined = [...baseVal, ...overVal];
      result[key] = [...new Set(combined)];
    } else if (
      overVal !== null &&
      typeof overVal === "object" &&
      !Array.isArray(overVal) &&
      baseVal !== null &&
      typeof baseVal === "object" &&
      !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overVal as Record<string, unknown>
      );
    } else if (overVal !== undefined) {
      result[key] = overVal;
    }
  }

  return result as T;
}

/**
 * Parse a JSONC file and return a plain object.
 * Returns `{}` on any error (missing file, parse error).
 */
function readJsoncFile(filePath: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return {};
  }

  const errors: ParseError[] = [];
  const parsed = parseJsonc(raw, errors);
  if (errors.length > 0) {
    // Non-fatal: return whatever was parsed (jsonc-parser is lenient)
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

/**
 * Ensure a config file exists, creating it with defaults if missing.
 */
function ensureConfigFile(filePath: string): void {
  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, DEFAULT_CONFIG_FILE_CONTENT, "utf8");
    }
  } catch {
    // Best-effort; do not crash if we cannot write
  }
}

/**
 * Resolve the global user config path.
 *
 * Prefer pi's agent-local convention. Keep the historical XDG-style path as a
 * read-only fallback; if neither exists, create the preferred file.
 */
function resolveGlobalConfigPath(): string {
  if (fs.existsSync(PREFERRED_GLOBAL_CONFIG_PATH)) return PREFERRED_GLOBAL_CONFIG_PATH;
  if (fs.existsSync(LEGACY_GLOBAL_CONFIG_PATH)) return LEGACY_GLOBAL_CONFIG_PATH;
  ensureConfigFile(PREFERRED_GLOBAL_CONFIG_PATH);
  return PREFERRED_GLOBAL_CONFIG_PATH;
}

/**
 * Walk up from `startDir` looking for `.pi/dcp.jsonc`.
 * Returns the path if found, otherwise null.
 */
function findProjectConfig(startDir: string): string | null {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;

  while (true) {
    const candidate = path.join(dir, ".pi", "dcp.jsonc");
    if (fs.existsSync(candidate)) return candidate;
    if (dir === root) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the DCP configuration by merging (in order):
 *  1. Built-in defaults
 *  2. ~/.pi/agent/dcp.jsonc, falling back to ~/.config/pi/dcp.jsonc if only the legacy file exists
 *  3. $PI_CONFIG_DIR/dcp.jsonc  (if env var is set)
 *  4. <project>/.pi/dcp.jsonc  (walked up from projectDir)
 */
export function loadConfig(projectDir: string): DcpConfig {
  // Layer 1: defaults (deep clone so we never mutate the constant)
  let config: DcpConfig = deepMerge(DEFAULT_CONFIG, {});

  // Layer 2: global config
  const globalRaw = readJsoncFile(resolveGlobalConfigPath());
  if (Object.keys(globalRaw).length > 0) {
    config = deepMerge(config, globalRaw as Partial<DcpConfig>);
  }

  // Layer 3: $PI_CONFIG_DIR/dcp.jsonc
  const piConfigDir = process.env["PI_CONFIG_DIR"];
  if (piConfigDir) {
    const envConfigPath = path.join(piConfigDir, "dcp.jsonc");
    const envRaw = readJsoncFile(envConfigPath);
    if (Object.keys(envRaw).length > 0) {
      config = deepMerge(config, envRaw as Partial<DcpConfig>);
    }
  }

  // Layer 4: project-local config (walk up from projectDir)
  const projectConfigPath = findProjectConfig(projectDir);
  if (projectConfigPath) {
    const projectRaw = readJsoncFile(projectConfigPath);
    if (Object.keys(projectRaw).length > 0) {
      config = deepMerge(config, projectRaw as Partial<DcpConfig>);
    }
  }

  return config;
}
