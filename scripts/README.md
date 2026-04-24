# Scripts

Developer/debugging utilities for this repository. These scripts are not part of the pi extension runtime path.

## `llm-proxy.ts`

`llm-proxy.ts` is a Bun-based local proxy for debugging DCP behavior against real LLM provider traffic. It captures request/response metadata so we can inspect what the model actually received after DCP pruning, compaction, provider-payload filtering, and self-forking.

### What it captures

For matching Anthropic/OpenAI requests, the proxy writes files under `tmp/llm-proxy/` by default:

- `*.json` — raw captured request body
- `*.md` — readable breakdown of system/developer prompts, tools, messages, sizes, and appended usage summary
- `*.usage.json` — token usage extracted from the upstream response, including input/output/cache-read/cache-write fields when available

The `tmp/` directory is intentionally gitignored. Captures may contain prompts, conversation history, tool outputs, file contents, credentials, or other sensitive data.

### Run

```bash
bun scripts/llm-proxy.ts
```

Useful variants:

```bash
bun scripts/llm-proxy.ts anthropic
bun scripts/llm-proxy.ts openai
bun scripts/llm-proxy.ts --port 9000
bun scripts/llm-proxy.ts --out ./tmp/llm-proxy
```

### Use with pi

Start the proxy in one terminal:

```bash
bun scripts/llm-proxy.ts
```

Run pi through it in another terminal:

```bash
PI_PROXY=true pi
```

Or explicitly set the proxy base URL:

```bash
PI_PROXY=true PI_PROXY_BASE_URL=http://localhost:8099 pi
```

For direct client routing, set provider base URLs:

```bash
ANTHROPIC_BASE_URL=http://localhost:8099 \
OPENAI_BASE_URL=http://localhost:8099 \
pi
```

### Upstream routing

By default the proxy forwards to the normal provider APIs. OpenAI Codex/ChatGPT OAuth traffic is routed to `https://chatgpt.com/backend-api/codex` when the relevant account headers are present.

Override upstream targets when needed:

```bash
ANTHROPIC_UPSTREAM_BASE_URL=https://api.anthropic.com/v1 \
OPENAI_UPSTREAM_BASE_URL=https://api.openai.com/v1 \
bun scripts/llm-proxy.ts
```

### DCP analysis workflow

Use captured `tmp/llm-proxy/*.md` and `*.usage.json` to evaluate:

- whether DCP pruned stale provider artifacts correctly
- whether compressed blocks are too verbose or too sparse
- whether tool exchanges are retained atomically
- whether self-forking preserves cache locality
- how much input is cached vs newly written between related requests

Do not commit captures. Share them only after reviewing for secrets and private data.
