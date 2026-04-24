#!/usr/bin/env bun

/**
 * LLM API Proxy — intercepts requests to AI providers and generates
 * detailed breakdowns of system prompts, tools, and messages. After each
 * upstream response, writes API token usage (input, output, cache read,
 * cache write) to `*.usage.json` and appends a summary to the `.md` file.
 *
 * Usage:
 *   bun scripts/llm-proxy.ts                           # all providers
 *   bun scripts/llm-proxy.ts anthropic                 # anthropic only
 *   bun scripts/llm-proxy.ts openai                    # openai only
 *   bun scripts/llm-proxy.ts --port 9000               # custom port
 *   bun scripts/llm-proxy.ts --out ./tmp/llm-proxy     # custom output dir
 *
 * Pi usage:
 *   PI_PROXY=true pi
 *   PI_PROXY=true PI_PROXY_BASE_URL=http://localhost:8099 pi
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders } from "node:http";
import http from "node:http";
import https from "node:https";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import zlib from "node:zlib";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
const OPENAI_CODEX_OAUTH_TARGET = "https://chatgpt.com/backend-api/codex";

// --- Provider definitions ---

interface Provider {
  readonly name: string;
  readonly defaultTarget: string;
  readonly requestPaths: readonly string[];
  readonly usageFormat: "anthropic" | "openai";
  readonly envVar: string;
  readonly upstreamEnvVar: string;
  extractSystem(body: Record<string, unknown>): unknown;
  extractTools(body: Record<string, unknown>): unknown[];
  extractMessages(body: Record<string, unknown>): unknown[];
  extractMeta(body: Record<string, unknown>): Record<string, unknown>;
}

function getOpenAiMessages(body: Record<string, unknown>): readonly Record<string, unknown>[] {
  const messages = body.messages;
  if (Array.isArray(messages)) {
    return messages.filter(
      (message): message is Record<string, unknown> =>
        typeof message === "object" && message !== null
    );
  }
  const input = body.input;
  if (Array.isArray(input)) {
    return input.filter(
      (message): message is Record<string, unknown> =>
        typeof message === "object" && message !== null
    );
  }
  return [];
}

function getOpenAiSystem(body: Record<string, unknown>): unknown {
  const instructions = body.instructions;
  if (typeof instructions === "string" && instructions.length > 0) {
    return instructions;
  }
  const messages = getOpenAiMessages(body);
  const system = messages.filter((message) => {
    const role = message.role;
    return role === "system" || role === "developer";
  });
  return system.length > 0 ? system : null;
}

function getOpenAiNonSystemMessages(body: Record<string, unknown>): unknown[] {
  return getOpenAiMessages(body).filter((message) => {
    const role = message.role;
    return role !== "system" && role !== "developer";
  });
}

const PROVIDERS: Record<string, Provider> = {
  anthropic: {
    name: "Anthropic",
    defaultTarget: "https://api.anthropic.com/v1",
    requestPaths: ["/messages"],
    usageFormat: "anthropic",
    envVar: "ANTHROPIC_BASE_URL",
    upstreamEnvVar: "ANTHROPIC_UPSTREAM_BASE_URL",
    extractSystem: (b) => b.system ?? null,
    extractTools: (b) => (b.tools as unknown[]) ?? [],
    extractMessages: (b) => (b.messages as unknown[]) ?? [],
    extractMeta: (b) => ({
      model: b.model,
      max_tokens: b.max_tokens,
      stream: b.stream,
      temperature: b.temperature,
    }),
  },
  openai: {
    name: "OpenAI",
    defaultTarget: "https://api.openai.com/v1",
    requestPaths: ["/chat/completions", "/responses"],
    usageFormat: "openai",
    envVar: "OPENAI_BASE_URL",
    upstreamEnvVar: "OPENAI_UPSTREAM_BASE_URL",
    extractSystem: getOpenAiSystem,
    extractTools: (b) => (b.tools as unknown[]) ?? [],
    extractMessages: getOpenAiNonSystemMessages,
    extractMeta: (b) => ({
      model: b.model,
      max_tokens: b.max_tokens ?? b.max_completion_tokens ?? b.max_output_tokens,
      stream: b.stream,
      temperature: b.temperature,
    }),
  },
};

// --- CLI args ---

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: "string", default: "8099" },
    out: { type: "string", default: "./tmp/llm-proxy" },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
  strict: true,
});

if (values.help) {
  console.log(`
LLM API Proxy — intercept and analyze AI provider requests

Usage:
  bun scripts/llm-proxy.ts [provider] [--port PORT] [--out DIR]

Providers: ${Object.keys(PROVIDERS).join(", ")} (default: all)

Options:
  --port PORT   Listen port (default: 8099)
  --out DIR     Output directory for captures (default: ./tmp/llm-proxy)
  -h, --help    Show this help

	Environment:
	  Pi routing:
	    PI_PROXY=true
	    PI_PROXY_BASE_URL=http://localhost:PORT   # optional, defaults to 8099
	  Direct client routing:
	    ANTHROPIC_BASE_URL=http://localhost:PORT
	    OPENAI_BASE_URL=http://localhost:PORT
	  Upstream overrides:
	    ANTHROPIC_UPSTREAM_BASE_URL=...
	    OPENAI_UPSTREAM_BASE_URL=...
	  OpenAI defaults to https://chatgpt.com/backend-api/codex for
	  ChatGPT/Codex OAuth traffic (when chatgpt-account-id is present),
	  otherwise https://api.openai.com/v1.
`);
  process.exit(0);
}

const PORT = Number.parseInt(values.port ?? "8099", 10);
const OUT_DIR = values.out ?? "./tmp/llm-proxy";
const FILTER = positionals[0]?.toLowerCase() ?? null;

if (FILTER && !PROVIDERS[FILTER]) {
  console.error(`Unknown provider: ${FILTER}. Available: ${Object.keys(PROVIDERS).join(", ")}`);
  process.exit(1);
}

const activeProviders = FILTER ? { [FILTER]: PROVIDERS[FILTER] } : PROVIDERS;
const RESOLVED_OUT_DIR = resolve(PROJECT_ROOT, OUT_DIR);

function ensureOutputDirExists(context: string): void {
  const wasMissing = !existsSync(RESOLVED_OUT_DIR);
  mkdirSync(RESOLVED_OUT_DIR, { recursive: true });
  if (wasMissing) {
    console.warn(`[proxy] Recreated output dir for ${context}: ${RESOLVED_OUT_DIR}`);
  }
}

ensureOutputDirExists("startup");

// --- Size helpers ---

function charSize(v: unknown): number {
  const serialized = JSON.stringify(v);
  return serialized?.length ?? 0;
}

function estimateTokens(chars: number): number {
  return Math.round(chars / 4);
}

function stringifyForPreview(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  const serialized = JSON.stringify(value);
  return serialized ?? "";
}

// --- Response usage (API tokens: input / output / cache read / cache write) ---

interface TokenUsageCapture {
  readonly provider: "anthropic" | "openai";
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cache_read_tokens: number | null;
  readonly cache_write_tokens: number | null;
  readonly raw_usage: unknown;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function headerString(headers: IncomingHttpHeaders, name: string): string {
  const v = headers[name];
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.join(",");
  return "";
}

function decompressBody(buffer: Buffer, headers: IncomingHttpHeaders): Buffer {
  const enc = headerString(headers, "content-encoding");
  if (enc.length === 0) return buffer;
  const lowered = enc.toLowerCase();
  if (lowered.includes("gzip")) {
    try {
      return Buffer.from(zlib.gunzipSync(buffer));
    } catch {
      return buffer;
    }
  }
  if (lowered.includes("br")) {
    try {
      return Buffer.from(zlib.brotliDecompressSync(buffer));
    } catch {
      return buffer;
    }
  }
  if (lowered.includes("deflate")) {
    try {
      return Buffer.from(zlib.inflateSync(buffer));
    } catch {
      return buffer;
    }
  }
  return buffer;
}

function parseSseJsonPayloads(body: string): unknown[] {
  const lines = body.split(/\r?\n/);
  const out: unknown[] = [];
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const rest = line.slice(5).trimStart();
    if (rest === "[DONE]" || rest === "") continue;
    try {
      out.push(JSON.parse(rest));
    } catch {
      // skip malformed SSE lines
    }
  }
  return out;
}

function looksLikeSseBody(body: string): boolean {
  const sample = body.slice(0, 4096);
  return (
    /(^|\n)event:\s*/m.test(sample) ||
    /(^|\n)data:\s*/m.test(sample) ||
    sample.startsWith("event:") ||
    sample.startsWith("data:")
  );
}

function mergeAnthropicUsageFields(base: Record<string, number>, patch: unknown): void {
  if (typeof patch !== "object" || patch === null) return;
  const p = patch as Record<string, unknown>;
  for (const key of [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ] as const) {
    if (key in p && p[key] !== undefined) {
      const n = asNumber(p[key]);
      if (n !== null) base[key] = n;
    }
  }
}

function extractAnthropicUsageFromSse(body: string): Record<string, unknown> | null {
  const merged: Record<string, number> = {};
  for (const payload of parseSseJsonPayloads(body)) {
    if (typeof payload !== "object" || payload === null) continue;
    const rec = payload as Record<string, unknown>;
    const eventType = rec.type;
    if (eventType === "message_start") {
      const message =
        typeof rec.message === "object" && rec.message !== null
          ? (rec.message as Record<string, unknown>)
          : null;
      mergeAnthropicUsageFields(merged, message?.usage);
    }
    if (eventType === "message_delta") {
      mergeAnthropicUsageFields(merged, rec.usage);
    }
  }
  if (Object.keys(merged).length === 0) return null;
  return merged as Record<string, unknown>;
}

function extractAnthropicUsageFromJson(obj: unknown): Record<string, unknown> | null {
  if (typeof obj !== "object" || obj === null) return null;
  const u = (obj as Record<string, unknown>).usage;
  if (typeof u !== "object" || u === null) return null;
  return u as Record<string, unknown>;
}

function extractOpenaiUsageFromSse(body: string): Record<string, unknown> | null {
  let last: Record<string, unknown> | null = null;
  for (const payload of parseSseJsonPayloads(body)) {
    if (typeof payload !== "object" || payload === null) continue;
    const u = (payload as Record<string, unknown>).usage;
    if (typeof u === "object" && u !== null) {
      last = u as Record<string, unknown>;
    }
  }
  return last;
}

function extractOpenaiResponsesUsageFromSse(body: string): Record<string, unknown> | null {
  let last: Record<string, unknown> | null = null;
  for (const payload of parseSseJsonPayloads(body)) {
    if (typeof payload !== "object" || payload === null) continue;
    const record = payload as Record<string, unknown>;
    const response =
      typeof record.response === "object" && record.response !== null
        ? (record.response as Record<string, unknown>)
        : null;
    const nestedUsage = response?.usage;
    if (typeof nestedUsage === "object" && nestedUsage !== null) {
      last = nestedUsage as Record<string, unknown>;
      continue;
    }
    const directUsage = record.usage;
    if (typeof directUsage === "object" && directUsage !== null) {
      last = directUsage as Record<string, unknown>;
    }
  }
  return last;
}

function extractOpenaiUsageFromJson(obj: unknown): Record<string, unknown> | null {
  if (typeof obj !== "object" || obj === null) return null;
  const u = (obj as Record<string, unknown>).usage;
  if (typeof u !== "object" || u === null) return null;
  return u as Record<string, unknown>;
}

function extractOpenaiResponsesUsageFromJson(obj: unknown): Record<string, unknown> | null {
  if (typeof obj !== "object" || obj === null) return null;
  const record = obj as Record<string, unknown>;
  const directUsage = record.usage;
  if (typeof directUsage === "object" && directUsage !== null) {
    return directUsage as Record<string, unknown>;
  }
  const response =
    typeof record.response === "object" && record.response !== null
      ? (record.response as Record<string, unknown>)
      : null;
  const nestedUsage = response?.usage;
  if (typeof nestedUsage !== "object" || nestedUsage === null) return null;
  return nestedUsage as Record<string, unknown>;
}

function normalizeAnthropicUsage(u: Record<string, unknown>): TokenUsageCapture {
  return {
    provider: "anthropic",
    input_tokens: asNumber(u.input_tokens),
    output_tokens: asNumber(u.output_tokens),
    cache_read_tokens: asNumber(u.cache_read_input_tokens),
    cache_write_tokens: asNumber(u.cache_creation_input_tokens),
    raw_usage: u,
  };
}

function normalizeOpenaiUsage(u: Record<string, unknown>): TokenUsageCapture {
  const pd =
    typeof u.prompt_tokens_details === "object" && u.prompt_tokens_details !== null
      ? (u.prompt_tokens_details as Record<string, unknown>)
      : null;
  return {
    provider: "openai",
    input_tokens: asNumber(u.prompt_tokens),
    output_tokens: asNumber(u.completion_tokens),
    cache_read_tokens: pd !== null ? asNumber(pd.cached_tokens) : null,
    cache_write_tokens: pd !== null ? asNumber(pd.cache_write_tokens) : null,
    raw_usage: u,
  };
}

function normalizeOpenaiResponsesUsage(u: Record<string, unknown>): TokenUsageCapture {
  const details =
    typeof u.input_tokens_details === "object" && u.input_tokens_details !== null
      ? (u.input_tokens_details as Record<string, unknown>)
      : null;
  return {
    provider: "openai",
    input_tokens: asNumber(u.input_tokens),
    output_tokens: asNumber(u.output_tokens),
    cache_read_tokens: details !== null ? asNumber(details.cached_tokens) : null,
    cache_write_tokens: details !== null ? asNumber(details.cache_write_tokens) : null,
    raw_usage: u,
  };
}

function isOpenaiResponsesPath(requestPath: string): boolean {
  const normalizedPath = normalizeRequestPath(requestPath);
  return (
    normalizedPath === "/responses" ||
    normalizedPath.startsWith("/responses/") ||
    normalizedPath === "/codex/responses" ||
    normalizedPath.startsWith("/codex/responses/")
  );
}

function parseUsageFromResponse(
  provider: Provider,
  body: Buffer,
  headers: IncomingHttpHeaders,
  requestPath: string
): TokenUsageCapture | null {
  const dec = decompressBody(body, headers);
  const text = dec.toString("utf8");
  const ct = headerString(headers, "content-type").toLowerCase();
  const isAnthropic = provider.usageFormat === "anthropic";
  const isOpenaiResponses = !isAnthropic && isOpenaiResponsesPath(requestPath);
  const isSse = ct.includes("text/event-stream") || looksLikeSseBody(text);

  let raw: Record<string, unknown> | null = null;
  if (isSse) {
    raw = isAnthropic
      ? extractAnthropicUsageFromSse(text)
      : isOpenaiResponses
        ? extractOpenaiResponsesUsageFromSse(text)
        : extractOpenaiUsageFromSse(text);
  } else {
    try {
      const json: unknown = JSON.parse(text);
      raw = isAnthropic
        ? extractAnthropicUsageFromJson(json)
        : isOpenaiResponses
          ? extractOpenaiResponsesUsageFromJson(json)
          : extractOpenaiUsageFromJson(json);
    } catch {
      return null;
    }
  }

  if (raw === null) return null;
  if (isAnthropic) return normalizeAnthropicUsage(raw);
  return isOpenaiResponses ? normalizeOpenaiResponsesUsage(raw) : normalizeOpenaiUsage(raw);
}

function logUsageParseDebug(
  provider: Provider,
  body: Buffer,
  headers: IncomingHttpHeaders,
  requestPath: string
): void {
  const dec = decompressBody(body, headers);
  const text = dec.toString("utf8");
  const contentType = headerString(headers, "content-type").toLowerCase() || "(none)";
  const contentEncoding = headerString(headers, "content-encoding") || "(none)";
  const normalizedPath = normalizeRequestPath(requestPath);
  const preview = text.slice(0, 400).replace(/\s+/g, " ").trim();
  const sseDetected = contentType.includes("text/event-stream") || looksLikeSseBody(text);
  console.warn(
    `[proxy] No usage parsed for ${provider.name} ${normalizedPath} | content-type=${contentType} | content-encoding=${contentEncoding} | bytes=${body.length} compressed / ${dec.length} decompressed | responsesPath=${isOpenaiResponsesPath(requestPath)} | sseDetected=${sseDetected}`
  );
  if (sseDetected) {
    const payloads = parseSseJsonPayloads(text);
    const directUsageEvents = payloads.filter((payload) => {
      if (typeof payload !== "object" || payload === null) return false;
      return (
        typeof (payload as Record<string, unknown>).usage === "object" &&
        (payload as Record<string, unknown>).usage !== null
      );
    }).length;
    const nestedResponseUsageEvents = payloads.filter((payload) => {
      if (typeof payload !== "object" || payload === null) return false;
      const response = (payload as Record<string, unknown>).response;
      if (typeof response !== "object" || response === null) return false;
      return (
        typeof (response as Record<string, unknown>).usage === "object" &&
        (response as Record<string, unknown>).usage !== null
      );
    }).length;
    console.warn(
      `[proxy] SSE usage debug: payloads=${payloads.length}, directUsageEvents=${directUsageEvents}, nestedResponseUsageEvents=${nestedResponseUsageEvents}`
    );
  }
  if (preview.length > 0) {
    console.warn(`[proxy] Response preview: ${preview}`);
  }
}

function formatUsageMarkdown(capture: TokenUsageCapture | null): string {
  const lines: string[] = [];
  lines.push("\n## Response usage (API)\n");
  if (capture === null) {
    lines.push(
      "_No usage parsed (empty body, non-JSON, or no usage in stream). Ensure streaming requests use `stream_options.include_usage` (OpenAI) where applicable._\n"
    );
    return lines.join("\n");
  }
  lines.push("| Metric | Tokens |");
  lines.push("|--------|--------|");
  lines.push(`| Input | ${capture.input_tokens ?? "—"} |`);
  lines.push(`| Output | ${capture.output_tokens ?? "—"} |`);
  lines.push(`| Cache read | ${capture.cache_read_tokens ?? "—"} |`);
  lines.push(`| Cache write | ${capture.cache_write_tokens ?? "—"} |`);
  lines.push("");
  lines.push(
    "_Anthropic: `input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`. OpenAI chat completions: `prompt_tokens` / `completion_tokens` / `prompt_tokens_details.cached_tokens`. OpenAI responses: `input_tokens` / `output_tokens` / `input_tokens_details.cached_tokens`._\n"
  );
  return lines.join("\n");
}

function writeUsageArtifacts(
  prefix: string,
  mdPath: string,
  capture: TokenUsageCapture | null,
  providerLabel: string
): void {
  ensureOutputDirExists("usage artifacts");
  const usagePath = join(RESOLVED_OUT_DIR, `${prefix}.usage.json`);
  try {
    writeFileSync(usagePath, JSON.stringify(capture, null, 2));
    appendFileSync(mdPath, formatUsageMarkdown(capture));
  } catch (err) {
    console.error(`[proxy] Usage write failed:`, err);
    return;
  }
  if (capture !== null) {
    console.log(
      `[${providerLabel}] tokens — in: ${capture.input_tokens ?? "?"}, out: ${capture.output_tokens ?? "?"}, cache read: ${capture.cache_read_tokens ?? "?"}, cache write: ${capture.cache_write_tokens ?? "?"}`
    );
  }
  console.log(`  -> ${usagePath}`);
}

// --- Markdown report ---

interface ToolEntry {
  readonly name: string;
  readonly chars: number;
}

interface SystemBlock {
  readonly index: number;
  readonly chars: number;
  readonly preview: string;
}

function generateReport(
  provider: Provider,
  body: Record<string, unknown>,
  system: unknown,
  tools: unknown[],
  messages: unknown[],
  meta: Record<string, unknown>
): string {
  const systemChars = charSize(system);
  const toolsChars = charSize(tools);
  const messagesChars = charSize(messages);
  const totalChars = charSize(body);

  const lines: string[] = [];

  lines.push(`# LLM Request Capture — ${provider.name}`);
  lines.push(`> Captured at ${new Date().toISOString()}\n`);

  // Summary table
  lines.push("## Summary\n");
  lines.push("| Component | Chars | Est. Tokens | % |");
  lines.push("|-----------|-------|-------------|---|");
  const components = [
    ["System prompt", systemChars],
    [`Tools (${tools.length})`, toolsChars],
    [`Messages (${messages.length})`, messagesChars],
  ] as const;
  for (const [name, chars] of components) {
    const pct = totalChars > 0 ? ((chars / totalChars) * 100).toFixed(1) : "0";
    lines.push(
      `| ${name} | ${chars.toLocaleString()} | ~${estimateTokens(chars).toLocaleString()} | ${pct}% |`
    );
  }
  lines.push(
    `| **Total** | **${totalChars.toLocaleString()}** | **~${estimateTokens(totalChars).toLocaleString()}** | 100% |`
  );

  // Meta
  lines.push("\n## Request Meta\n");
  for (const [key, val] of Object.entries(meta)) {
    if (val !== undefined && val !== null) {
      lines.push(`- **${key}**: \`${val}\``);
    }
  }

  // System prompt
  lines.push("\n## System Prompt\n");
  if (system === null) {
    lines.push("_(empty)_");
  } else if (Array.isArray(system)) {
    lines.push(`${system.length} block(s), ${systemChars.toLocaleString()} chars total\n`);
    const blocks: SystemBlock[] = system.map((block, i) => {
      const text =
        typeof block === "string" ? block : ((block as Record<string, unknown>).text ?? "");
      const content = stringifyForPreview(text);
      return {
        index: i,
        chars: content.length,
        preview: content.slice(0, 150).replace(/\n/g, " "),
      };
    });
    lines.push("| Block | Chars | Preview |");
    lines.push("|-------|-------|---------|");
    for (const b of blocks) {
      lines.push(`| ${b.index} | ${b.chars.toLocaleString()} | ${b.preview}... |`);
    }
  } else if (typeof system === "string") {
    lines.push(`${systemChars.toLocaleString()} chars\n`);
    lines.push("```");
    lines.push(system.slice(0, 2000));
    if (system.length > 2000) lines.push(`\n... (${system.length - 2000} chars truncated)`);
    lines.push("```");
  }

  // Tools
  lines.push("\n## Tools\n");
  if (tools.length === 0) {
    lines.push("_(none)_");
  } else {
    const toolEntries: ToolEntry[] = tools
      .map((t) => ({
        name: String((t as Record<string, unknown>).name ?? "?"),
        chars: charSize(t),
      }))
      .sort((a, b) => b.chars - a.chars);

    lines.push("| Tool | Chars | Est. Tokens |");
    lines.push("|------|-------|-------------|");
    for (const t of toolEntries) {
      lines.push(
        `| ${t.name} | ${t.chars.toLocaleString()} | ~${estimateTokens(t.chars).toLocaleString()} |`
      );
    }
    lines.push(
      `| **Total** | **${toolsChars.toLocaleString()}** | **~${estimateTokens(toolsChars).toLocaleString()}** |`
    );
  }

  // Messages
  lines.push("\n## Messages\n");
  if (messages.length === 0) {
    lines.push("_(none)_");
  } else {
    lines.push(`${messages.length} message(s), ${messagesChars.toLocaleString()} chars\n`);
    lines.push("| # | Role | Chars | Preview |");
    lines.push("|---|------|-------|---------|");
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i] as Record<string, unknown>;
      const role = String(msg.role ?? "?");
      const content = stringifyForPreview(msg.content);
      const preview = content.slice(0, 100).replace(/\n/g, " ");
      lines.push(`| ${i} | ${role} | ${charSize(msg).toLocaleString()} | ${preview} |`);
    }
  }

  return lines.join("\n");
}

/** Strip hop-by-hop / connection-specific headers — forwarding them breaks clients when not using pipe() semantics. */
function sanitizeForwardedResponseHeaders(
  headers: IncomingHttpHeaders
): Record<string, string | number | string[]> {
  const out: Record<string, string | number | string[]> = {};
  for (const [key, val] of Object.entries(headers)) {
    if (val === undefined) continue;
    const lower = key.toLowerCase();
    if (
      lower === "connection" ||
      lower === "keep-alive" ||
      lower === "proxy-authenticate" ||
      lower === "proxy-authorization" ||
      lower === "te" ||
      lower === "trailer" ||
      lower === "transfer-encoding" ||
      lower === "upgrade"
    ) {
      continue;
    }
    out[key] = val;
  }
  return out;
}

// --- Hop-by-hop headers to strip on forwarding (RFC 2616 §13.5.1) ---

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function logRateLimitHeaders(headers: IncomingHttpHeaders): void {
  const parts: string[] = [];
  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase();
    if (
      lower.startsWith("x-ratelimit-") ||
      lower.startsWith("anthropic-ratelimit-") ||
      lower === "retry-after" ||
      lower === "retry-after-ms" ||
      lower === "request-id"
    ) {
      parts.push(`${key}: ${headers[key]}`);
    }
  }
  if (parts.length > 0) {
    console.warn(`[proxy] 429 rate-limit headers — ${parts.join(", ")}`);
  } else {
    console.warn("[proxy] 429 rate-limit headers — (none present)");
  }
}

function appendForwardHeader(headers: OutgoingHttpHeaders, key: string, value: string): void {
  const existing = headers[key];
  if (existing === undefined) {
    headers[key] = value;
    return;
  }
  if (Array.isArray(existing)) {
    headers[key] = [...existing, value];
    return;
  }
  headers[key] = [String(existing), value];
}

function buildForwardHeaders(
  req: IncomingMessage,
  targetHost: string,
  bodyLength: number
): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const rawKey = req.rawHeaders[i];
    const rawValue = req.rawHeaders[i + 1];
    if (rawKey === undefined || rawValue === undefined) continue;
    const key = rawKey.toLowerCase();
    if (key === "host" || key === "content-length" || HOP_BY_HOP.has(key)) {
      continue;
    }
    appendForwardHeader(headers, key, rawValue);
  }
  headers.host = targetHost;
  headers["content-length"] = String(bodyLength);
  return headers;
}

function getHeaderValues(
  headers: IncomingHttpHeaders | OutgoingHttpHeaders,
  name: string
): readonly string[] {
  const values: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name.toLowerCase() || value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) values.push(String(item));
      continue;
    }
    values.push(String(value));
  }
  return values;
}

function logAnthropicBetaHeaders(
  label: string,
  headers: IncomingHttpHeaders | OutgoingHttpHeaders
): void {
  const values = getHeaderValues(headers, "anthropic-beta");
  if (values.length === 0) {
    console.log(`[proxy] ${label} anthropic-beta: (none)`);
    return;
  }
  console.log(`[proxy] ${label} anthropic-beta: ${values.join(" | ")}`);
}

function logOpenAiAuthHeaders(
  label: string,
  headers: IncomingHttpHeaders | OutgoingHttpHeaders
): void {
  const accountIds = getHeaderValues(headers, "chatgpt-account-id");
  const organizations = getHeaderValues(headers, "openai-organization");
  const projects = getHeaderValues(headers, "openai-project");
  const authorizations = getHeaderValues(headers, "authorization");
  const authKind =
    authorizations.length === 0
      ? "(none)"
      : authorizations.every((value) => value.startsWith("Bearer "))
        ? "bearer"
        : "present";
  const mode = accountIds.length > 0 ? "oauth-codex" : "platform";
  console.log(
    `[proxy] ${label} openai auth headers: mode=${mode}, authorization=${authKind}, chatgpt-account-id=${accountIds.length > 0 ? accountIds.join(" | ") : "(none)"}, openai-organization=${organizations.length > 0 ? organizations.join(" | ") : "(none)"}, openai-project=${projects.length > 0 ? projects.join(" | ") : "(none)"}`
  );
}

function isOpenAiCodexOauthRequest(headers: IncomingHttpHeaders | OutgoingHttpHeaders): boolean {
  return getHeaderValues(headers, "chatgpt-account-id").length > 0;
}

// --- Detect provider from request path ---

function normalizeRequestPath(url: string): string {
  const pathname = new URL(url, "http://localhost").pathname;
  if (pathname.startsWith("/v1/")) {
    return pathname.slice(3);
  }
  if (pathname === "/v1") {
    return "/";
  }
  return pathname;
}

function detectProviderFromHeaders(
  headers: IncomingHttpHeaders | OutgoingHttpHeaders
): Provider | null {
  const anthropicMatch =
    activeProviders.anthropic &&
    (getHeaderValues(headers, "anthropic-version").length > 0 ||
      getHeaderValues(headers, "anthropic-beta").length > 0 ||
      getHeaderValues(headers, "x-api-key").length > 0)
      ? activeProviders.anthropic
      : null;
  const openAiMatch =
    activeProviders.openai &&
    (getHeaderValues(headers, "chatgpt-account-id").length > 0 ||
      getHeaderValues(headers, "openai-organization").length > 0 ||
      getHeaderValues(headers, "openai-project").length > 0 ||
      getHeaderValues(headers, "authorization").length > 0)
      ? activeProviders.openai
      : null;
  if (anthropicMatch && !openAiMatch) return anthropicMatch;
  if (openAiMatch && !anthropicMatch) return openAiMatch;
  return null;
}

function detectProvider(
  path: string,
  headers: IncomingHttpHeaders | OutgoingHttpHeaders
): Provider | null {
  const normalizedPath = normalizeRequestPath(path);
  const pathMatches = Object.values(activeProviders).filter((provider) =>
    provider.requestPaths.some(
      (requestPath) =>
        normalizedPath === requestPath || normalizedPath.startsWith(`${requestPath}/`)
    )
  );
  if (pathMatches.length === 1) {
    return pathMatches[0];
  }

  const headerMatch = detectProviderFromHeaders(headers);
  if (headerMatch) return headerMatch;

  const providers = Object.values(activeProviders);
  if (providers.length === 1) {
    return providers[0] ?? null;
  }
  return null;
}

function getProviderTarget(
  provider: Provider,
  headers: IncomingHttpHeaders | OutgoingHttpHeaders
): URL {
  const configuredTarget = process.env[provider.upstreamEnvVar];
  const rawTarget =
    configuredTarget?.trim() ||
    (provider === PROVIDERS.openai && isOpenAiCodexOauthRequest(headers)
      ? OPENAI_CODEX_OAUTH_TARGET
      : provider.defaultTarget);
  return new URL(rawTarget);
}

function buildForwardPath(target: URL, requestUrl: string): string {
  const incomingUrl = new URL(requestUrl, "http://localhost");
  const targetPath = target.pathname.endsWith("/") ? target.pathname.slice(0, -1) : target.pathname;
  const normalizedPath = normalizeRequestPath(requestUrl);
  let requestPath = normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`;

  if (targetPath.endsWith("/codex") && requestPath.startsWith("/codex/")) {
    requestPath = requestPath.slice("/codex".length);
  } else if (targetPath.endsWith("/codex") && requestPath === "/codex") {
    requestPath = "/";
  }

  return `${targetPath}${requestPath}${incomingUrl.search}`;
}

// --- Server ---

let captureCount = 0;

const server = http.createServer((req, res) => {
  console.log(`[proxy] ${req.method} ${req.url}`);
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const rawBytes = Buffer.concat(chunks);
    console.log(`[proxy] Body: ${rawBytes.length} bytes, path: ${req.url}`);

    if (req.method !== "POST" || rawBytes.length === 0) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Capture-only proxy — no forwarding" }));
      return;
    }

    const provider = detectProvider(req.url ?? "/", req.headers);

    if (!provider) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error:
            "Unable to determine provider from request path or headers; configure a single provider filter or use recognizable provider auth headers",
          path: req.url ?? "/",
        })
      );
      return;
    }

    const forwardBytes = rawBytes;

    // Prepare capture file paths (cheap — no body parsing)
    captureCount++;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const prefix = `${timestamp}_${provider.name.toLowerCase()}_${captureCount}`;
    const jsonPath = join(RESOLVED_OUT_DIR, `${prefix}.json`);
    const mdPath = join(RESOLVED_OUT_DIR, `${prefix}.md`);

    // --- DEFERRED: all capture + report work runs off the forwarding path ---
    const requestCaptureReady = new Promise<void>((resolve) => {
      setImmediate(() => {
        let body: Record<string, unknown>;
        const raw = forwardBytes.toString("utf8");
        try {
          body = JSON.parse(raw);
        } catch {
          console.error("[proxy] Capture: failed to parse request body");
          resolve();
          return;
        }

        try {
          ensureOutputDirExists("request capture");
          const system = provider.extractSystem(body);
          const tools = provider.extractTools(body);
          const messages = provider.extractMessages(body);
          const meta = provider.extractMeta(body);
          const report = generateReport(provider, body, system, tools, messages, meta);
          writeFileSync(jsonPath, JSON.stringify(body, null, 2));
          writeFileSync(mdPath, report);
          const totalChars = charSize(body);
          console.log(
            `[${provider.name}] #${captureCount} | ${totalChars.toLocaleString()} chars (~${estimateTokens(totalChars).toLocaleString()} tokens) | ${tools.length} tools | ${messages.length} msgs`
          );
          console.log(`  -> ${jsonPath}`);
          console.log(`  -> ${mdPath}`);
        } catch (err) {
          console.error("[proxy] Capture write failed:", err);
        }
        resolve();
      });
    });

    // --- FORWARD: stream raw bytes upstream with minimal perturbation ---
    const target = getProviderTarget(provider, req.headers);
    const targetHost = target.host;
    const fwdHeaders = buildForwardHeaders(req, targetHost, forwardBytes.length);
    const fwdPath = buildForwardPath(target, req.url ?? "/");
    const forwardUrl = new URL(fwdPath, `${target.protocol}//${target.host}`);
    console.log(`[proxy] Forward target: ${forwardUrl.toString()}`);

    if (provider.name === "Anthropic") {
      logAnthropicBetaHeaders("request", fwdHeaders);
    }
    if (provider.name === "OpenAI") {
      logOpenAiAuthHeaders("request", fwdHeaders);
    }

    const requestModule = target.protocol === "http:" ? http : https;
    const proxyReq = requestModule.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port.length > 0 ? Number.parseInt(target.port, 10) : undefined,
        path: fwdPath,
        method: req.method,
        headers: fwdHeaders,
      },
      (proxyRes) => {
        const statusCode = proxyRes.statusCode ?? 502;
        console.log(`[proxy] Upstream response: ${statusCode} ${proxyRes.headers["content-type"]}`);

        if (provider.name === "Anthropic") {
          logAnthropicBetaHeaders("response", proxyRes.headers);
        }
        if (provider.name === "OpenAI") {
          logOpenAiAuthHeaders("response", proxyRes.headers);
        }

        if (statusCode === 429) {
          logRateLimitHeaders(proxyRes.headers);
        }

        const responseChunks: Buffer[] = [];
        proxyRes.on("data", (chunk: Buffer) => {
          responseChunks.push(chunk);
        });
        res.writeHead(statusCode, sanitizeForwardedResponseHeaders(proxyRes.headers));
        proxyRes.pipe(res);
        proxyRes.on("end", () => {
          const responseBody = Buffer.concat(responseChunks);

          if (statusCode === 429) {
            const preview = decompressBody(responseBody, proxyRes.headers)
              .toString("utf8")
              .slice(0, 200);
            console.warn(`[proxy] 429 body: ${preview}`);
          }

          const capture = parseUsageFromResponse(
            provider,
            responseBody,
            proxyRes.headers,
            req.url ?? "/"
          );
          if (capture === null) {
            logUsageParseDebug(provider, responseBody, proxyRes.headers, req.url ?? "/");
          }
          void requestCaptureReady
            .then(() => {
              writeUsageArtifacts(prefix, mdPath, capture, provider.name);
            })
            .catch(() => {
              writeUsageArtifacts(prefix, mdPath, capture, provider.name);
            });
          console.log(`[proxy] Response stream ended (${responseBody.length} bytes)`);
        });
        proxyRes.on("error", (e) => {
          console.error(`[proxy] Upstream response error: ${e.message}`);
          if (!res.writableEnded) {
            res.destroy();
          }
        });
      }
    );
    proxyReq.on("error", (e) => {
      console.error(`[proxy] Forward error: ${e.message}`);
      if (!res.headersSent) {
        res.writeHead(502);
        res.end("Proxy error");
      }
    });
    proxyReq.write(forwardBytes);
    proxyReq.end();
  });
});

server.listen(PORT, () => {
  console.log(`\nLLM Proxy (capture-only) listening on http://localhost:${PORT}`);
  console.log(`Pi extension env: PI_PROXY=true PI_PROXY_BASE_URL=http://localhost:${PORT}`);
  console.log(
    `Providers: ${Object.values(activeProviders)
      .map((p) => p.name)
      .join(", ")}`
  );
  console.log(`Output: ${RESOLVED_OUT_DIR}`);
  console.log("");
  for (const provider of Object.values(activeProviders)) {
    if (provider === PROVIDERS.openai) {
      const configuredTarget = process.env[provider.upstreamEnvVar]?.trim();
      console.log(
        configuredTarget
          ? `Upstream ${provider.name}: ${configuredTarget}`
          : `Upstream ${provider.name}: request-dependent (oauth-codex -> ${OPENAI_CODEX_OAUTH_TARGET}, platform -> ${provider.defaultTarget})`
      );
      continue;
    }
    console.log(`Upstream ${provider.name}: ${getProviderTarget(provider, {}).toString()}`);
  }
  console.log("");

  console.log(`Run:\n  PI_PROXY=true PI_PROXY_BASE_URL=http://localhost:${PORT} pi\n`);
});
