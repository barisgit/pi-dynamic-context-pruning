# DCP eval and proxy plan

Date: 2026-04-23
Purpose: turn `llm-proxy` captures and DCP debug logs into a measurable regression/eval loop.

## Why this exists

DCP currently estimates savings internally, but does not answer the expensive questions:

- Did a compress actually reduce provider input tokens on the next request?
- Did it destroy prompt-cache reads and create expensive cache writes?
- How many provider payload artifacts were removed?
- How much token overhead comes from DCP metadata, nudges, and block rendering?
- Did internal protocol markers leak into model-visible text or tool args?

The proxy already captures most raw ingredients. The missing piece is correlation and replay.

## Existing data sources

### DCP debug log

Path: `~/.pi/log/dcp.jsonl`

Current logs include extension/session lifecycle, state saves, context evaluation, nudge emission, provider-payload filtering, and compress success/failure. If a field is missing, prefer adding it to `debug-log.ts` rather than inferring from rendered text.

Recommended fields to ensure exist:

```json
{
  "timestamp": "ISO-8601",
  "sessionId": "...",
  "leafId": "...",
  "event": "compress_success",
  "blockId": 7,
  "activeBlockCount": 3,
  "savedTokenEstimate": 12345,
  "contextTokens": 45678,
  "contextPercent": 61.2,
  "coveredSourceKeys": 42,
  "coveredSpanKeys": 17,
  "coveredToolIds": 9
}
```

For provider filtering:

```json
{
  "event": "provider_payload_filter",
  "inputItemsBefore": 120,
  "inputItemsAfter": 91,
  "removedReasoning": 12,
  "removedFunctionCalls": 8,
  "removedFunctionOutputs": 9,
  "representedCompressArtifacts": 1
}
```

### Proxy captures

Relevant script: `/Users/blaz/Programming_local/Projects/sessionloom/scripts/llm-proxy.ts`

Known outputs:
- `.json`: full provider request
- `.md`: human-readable component report
- `.usage.json`: usage tokens and cache read/write tokens

Known useful environment:
- `PI_PROXY=true`
- `PI_PROXY_BASE_URL=http://localhost:PORT`
- `ANTHROPIC_BASE_URL=http://localhost:PORT`
- `OPENAI_BASE_URL=http://localhost:PORT`
- `PI_PROXY_REUSE_PARENT_PROMPT_CACHE_KEY=true` for OpenAI fork experiments

## Artifact 1 — correlation report script

Proposed path: `scripts/dcp-proxy-report.ts`

### Inputs

```bash
bun run scripts/dcp-proxy-report.ts \
  --dcp-log ~/.pi/log/dcp.jsonl \
  --proxy-dir ~/.pi/tmp/llm-proxy \
  --out research/eval-runs/<run-id>/report.md \
  --csv research/eval-runs/<run-id>/events.csv
```

### Output sections

1. Session summary
   - provider/model counts
   - request count
   - total input/output tokens
   - total cache read/write tokens
   - total estimated DCP savings

2. Compress event table
   - compress timestamp
   - block ID
   - next request input tokens
   - previous request input tokens
   - next request cache read/write tokens
   - delta input tokens
   - delta cache read/write tokens

3. Provider payload filtering table
   - items before/after
   - artifact classes removed
   - estimated removed item chars/tokens if available

4. Metadata overhead table
   - count of `<dcp-id>` tags
   - count of `<dcp-owner>` tags if any remain
   - count/size of block metadata tags
   - nudge chars/tokens

5. Marker leakage scan
   - occurrences of `<dcp-owner>`
   - occurrences of `<parameter name="owner">`
   - bare owner-key tokens like `s123` near tool args
   - bare message IDs like `m123` inside file content/tool args

### CSV columns

```csv
timestamp,kind,provider,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,active_blocks,estimated_saved_tokens,input_items_before,input_items_after,removed_reasoning,removed_function_call,removed_function_call_output,metadata_chars,nudge_chars,marker_leak_count,capture_file
```

## Artifact 2 — capture replay regression script

Proposed path: `scripts/replay-proxy-capture.ts`

### Goal

Use real provider request shapes as regression fixtures without sending requests upstream.

### Inputs

```bash
bun run scripts/replay-proxy-capture.ts \
  --capture ~/.pi/tmp/llm-proxy/2026-04-23T10-43-49_openai_3.json \
  --mode marker-scan
```

Future modes:
- `marker-scan`: detect DCP/internal marker leakage.
- `payload-filter`: run `filterProviderPayloadInput()` with synthetic live owners.
- `materialize`: run canonical materialization with synthetic compression blocks.
- `shape-check`: assert no orphaned tool-result pairs and provider-valid ordering.

### Regression checks

- No `<dcp-owner>` in model-visible text.
- No DCP marker inside tool call args or file content except intentional `compress` IDs.
- No orphaned tool result without corresponding assistant tool call.
- No `function_call_output` for compressed/stale owner.
- Empty provider input is avoided or handled explicitly.
- Prompt shape is byte-stable for repeated materialization.

## Artifact 3 — eval run directory convention

Proposed path: `research/eval-runs/README.md`

Suggested layout:

```text
research/eval-runs/
  2026-04-23-baseline/
    notes.md
    events.csv
    report.md
    proxy-files.txt
  2026-04-24-no-owner-tags/
    notes.md
    events.csv
    report.md
  2026-04-25-provider-edits-prototype/
    notes.md
    events.csv
    report.md
```

Do not commit raw provider captures unless they are redacted and intentionally curated. Commit reports and small synthetic fixtures instead.

## Baseline experiment protocol

### Experiment A — current baseline

1. Start proxy.
2. Enable DCP debug logging.
3. Run a normal coding session with reads, edits, tests, and at least two `compress` calls.
4. Generate report.
5. Record cache read/write behavior around compress events.

### Experiment B — no owner tags

1. Apply/hide owner-marker patch.
2. Repeat a similar workflow.
3. Compare:
   - metadata overhead
   - marker leakage incidents
   - provider payload filtering counts
   - input/cache tokens

### Experiment C — standalone nudges

1. Change nudge rendering to avoid mutating historical message content.
2. Repeat workflow near threshold.
3. Compare prompt churn and cache writes.

### Experiment D — provider-native edits

1. Enable experimental Anthropic context edit path.
2. Repeat workflow with tool-heavy session.
3. Compare cache write tokens after compress vs baseline.

## Decision gates

### Owner marker patch

Ship if:
- marker leakage count drops to zero in model-visible transcript
- provider artifact filtering stays equivalent or improves
- no new orphaned tool/provider-shape failures

### Provider-native edits

Ship only if:
- measurable cache-write reduction or cache-read preservation is observed
- fallback behavior is safe
- model/provider compatibility matrix is documented

### V2 materialization

Ship behind a config flag first if:
- repeated render determinism passes
- migration fixtures pass
- proxy replay shape checks pass on curated captures

## Minimal first script implementation

Start with read-only reporting; do not mutate DCP or proxy.

Pseudo-flow:

```ts
const dcpEvents = readJsonl(dcpLog)
const usageFiles = findUsageJson(proxyDir)
const captures = usageFiles.map(loadUsageWithTimestamp)

for (const capture of captures) {
  const nearbyEvents = findEventsWithin(capture.timestamp, dcpEvents, 10_000)
  emitRow(capture, nearbyEvents)
}

writeCsv(rows)
writeMarkdown(summary(rows))
```

Approximate timestamps are acceptable for the first version. Later, add shared session/request IDs to both DCP debug logs and proxy captures.

## Notes on raw capture hygiene

Provider captures can contain secrets, source code, prompts, and user data. Default policy:

- Keep raw captures outside git.
- Commit only redacted/synthetic fixtures.
- Reports should avoid dumping full prompt bodies.
- Marker scans can report counts and short sanitized snippets.

## First concrete next step

Create `scripts/dcp-proxy-report.ts` with:
- JSONL parser
- proxy usage discovery
- timestamp correlation
- CSV output
- marker count scan from adjacent `.json` request capture

This gives immediate visibility into whether the next code changes improve real sessions.
