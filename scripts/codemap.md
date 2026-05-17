# scripts/ — Codemap

## Responsibility

The `scripts/` directory houses standalone development and debugging utilities for the DCP extension. All scripts are executed with `bun`, not as part of the extension's runtime.

---

## Files

### `llm-proxy.ts`

Local HTTP proxy server that intercepts outbound LLM API requests (Anthropic `/messages`, OpenAI `/chat/completions`, OpenAI `/responses`) and writes structured request/response artifacts to disk for analysis.

**Responsibilities:**

- Acts as a capture-only proxy: forwards requests upstream unchanged while simultaneously writing a snapshot.
- Supports two providers: `anthropic` and `openai` (filterable by CLI positional argument).
- Detects the provider from request path and auth headers (API key, `anthropic-version`, `openai-organization`, etc.).
- Handles both standard JSON and SSE response bodies, decompressing `gzip`/`br`/`deflate` as needed.
- Extracts and normalises API token usage (input, output, cache read, cache write) across all three payload shapes (Anthropic messages, OpenAI chat completions, OpenAI responses).
- Writes two files per capture:
  - `${prefix}.json` — raw request body.
  - `${prefix}.md` — human-readable report with a summary table, system-prompt section, tools table, and messages table, plus a usage section appended after the upstream response arrives.
  - `${prefix}.usage.json` — structured token-usage capture.

**CLI usage:**

```
bun scripts/llm-proxy.ts [provider] [--port PORT] [--out DIR]
```

**Pi integration:** Set `PI_PROXY=true` and `PI_PROXY_BASE_URL=http://localhost:PORT` to route pi's LLM calls through the proxy.
