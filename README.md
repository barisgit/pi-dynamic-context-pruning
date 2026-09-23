# Dynamic Context Pruning (DCP) for Pi

Maintains useful working context in long Pi sessions through authored historical records, selective tool-output pruning, and compaction checkpoints. Intent, restrictions, corrections, and verification evidence take priority over minimum token count or maximum cache reuse. Compression is not a guarantee of losslessness.

## Features

- **Compress tool** — replaces settled conversation ranges with agent-authored historical summaries; retains the newest records in progressively leaner model-visible tiers while canonical history remains intact
- **Deduplication** — replaces older results only when the request, visible content, and error status match a retained newer result
- **Jev review** — optional keep/drop judgments for eligible outputs every configured pruning cadence; shadow mode only records them, explicit live mode applies accepted recoverable drops
- **Context nudges** — injects compression reminders into the context at configurable thresholds: soft housekeeping notices, strong emergency warnings, and iteration reminders after long tool-call chains
- **Session persistence via direct restore** — compression blocks and pruning state survive session restarts. Active blocks are persisted with exact coverage/anchor metadata and restored directly; replay is kept only for offline vacuum/verification scripts.
- **Native pi compaction bridge** — builds a budgeted checkpoint from retained DCP records plus a fresh, tail-informed orientation, with coverage-gated host fallback
- **Original-output recovery** — `dcp_recover` reads saved tool results or exposed fo Refs without rerunning the original operation
- **Debug logging** — optional best-effort JSONL diagnostics at `~/.pi/log/dcp.jsonl`
- **`/dcp` commands** — inspect context usage, view stats, and trigger compression interactively

## Installation

### Global (applies to all pi sessions)

```bash
pi install npm:@complexthings/pi-dynamic-context-pruning
```

### Install globally from GitHub

```bash
pi install https://github.com/complexthings/pi-dynamic-context-pruning
```

### Try it without installing

```bash
pi -e https://github.com/complexthings/pi-dynamic-context-pruning
```

## Documentation map

- `README.md` — user-facing install, config, commands, and current shipped behavior
- `AGENTS.md` — contributor/agent-oriented architecture guide for editing this repo
- `DCP_V2_DESIGN.md` — target architecture and future-state design notes; parts are intentionally aspirational
- `tests/` — Bun test suites for current runtime semantics, split by behavior area

If you are modifying DCP behavior rather than just using it, read `AGENTS.md` first.

## Configuration

DCP uses a layered configuration system (later layers override earlier ones):

1. Built-in defaults
2. `~/.pi/agent/dcp.jsonc` — preferred global user config (auto-created with defaults on first run)
   - fallback: `~/.config/pi/dcp.jsonc` is still read when the preferred file does not exist
3. `$PI_CONFIG_DIR/dcp.jsonc` — if the env var is set
4. `<project>/.pi/dcp.jsonc` — project-local overrides (walk up from cwd)

### Example: `~/.pi/agent/dcp.jsonc`

The example uses package pruning defaults: **25 tokens/item, 100 tokens/batch, 1 logical turn/cadence**. The current user deployment deliberately keeps **100 / 10,000 / 25**, respectively; these are user overrides, not new package defaults. Its native checkpoint overrides remain **35,000 tokens** and **0.50 minimum hidden coverage**. Age/size settings only make outputs eligible for review; they do not authorize age-only deletion.

```jsonc
{
  // Disable the extension entirely
  // "enabled": false,

  // Best-effort JSONL diagnostics at ~/.pi/log/dcp.jsonl
  // "debug": false,

  "compress": {
    // Above 90 % context: fire an emergency nudge
    "maxContextPercent": 0.9,
    // Below 75 % context: no nudges
    "minContextPercent": 0.75,
    // Optional absolute-token thresholds. These are ORed with percent thresholds.
    // Useful for 1M-token models that degrade around 150k-200k tokens.
    // "maxContextTokens": 200000,
    // "minContextTokens": 150000,
    // Minimum newer logical turns between nudges
    "nudgeDebounceTurns": 2,
    // Legacy context-pass cadence knob (retained for backward compatibility)
    "nudgeFrequency": 8,
    // Nudge after this many tool calls since the last user message
    "iterationNudgeThreshold": 15,
    // Protect the hot tail beginning at the Nth-most-recent logical turn/tool batch
    "protectRecentTurns": 4,
    // Newest compressed blocks rendered with the full deterministic record
    "renderFullBlockCount": 4,
    // Next older blocks render the whole authored summary only; older blocks
    // remain coverage-bearing but are omitted from model-visible context
    "renderCompactBlockCount": 8,
    // "strong" = emergency tone, "soft" = housekeeping tone
    "nudgeForce": "soft",
    // These tool outputs are never auto-pruned
    "protectedTools": ["compress", "write", "edit"],
  },
  "nativeCompaction": {
    // Normal DCP compression requests pi-native compaction immediately when
    // the active branch has this many user/assistant/toolResult/bashExecution
    // messages and active DCP blocks exist. Passthrough entries (DCP
    // reminders, prior compactions, branch summaries) are not counted.
    "enabled": true,
    "autoTriggerMessageCount": 1000,
    "autoTriggerForceMessageCount": 2000,
    "minActiveBlockCount": 1,
    // Current user overrides; package defaults may differ
    "minHiddenCoverageRatio": 0.5,
    "maxSummaryTokens": 35000,
  },
  "strategies": {
    // Batch heuristic tombstone additions onto turn boundaries that are
    // multiples of N. Within a bucket, prunedToolIds does not grow, so the
    // rendered prefix stays cache-stable. 1 = legacy per-turn behavior.
    // Higher values (e.g. 10, 20) trade carrying noisy tool output a bit
    // longer for at most one prefix-cache break per N turns from these
    // strategies combined. Stateless: nothing is persisted, so reloads can
    // never trigger a spurious flush.
    "pruneCadenceTurns": 1,
    // Minimum net tokens a tombstone must save before it is worth a
    // prefix-cache break (Anthropic clear_at_least analogue). netSaved =
    // toolResultTokens - tombstoneTokens. Per-item skips tiny outputs; batch
    // refuses to rewrite old context unless the whole flush clears the bar.
    // 0 = off (every cadence-eligible candidate commits); shipped defaults
    // 25 / 100 drop net-negative and trivially-small tombstones. Both gates are
    // bypassed when effective context enters the red zone
    // (compress.maxContextPercent / compress.maxContextTokens).
    "minPruneItemSavedTokens": 25,
    "minPruneBatchSavedTokens": 100,
    "deduplication": {
      "enabled": true,
      // Additional tools to exclude from dedup
      "protectedTools": [],
    },
    "jev": { "enabled": false },
    "candidates": {
      "minAgeTurns": 15,
      "minResultTokens": 300,
      "protectedTools": [],
    },
  },

  // Glob patterns — matching file paths are never pruned
  "protectedFilePatterns": [],
  // "off" | "minimal" | "detailed"
  "pruneNotification": "detailed",
}
```

## Commands

All commands are available in the pi TUI via `/dcp <subcommand>`:

| Command               | Description                                                     |
| --------------------- | --------------------------------------------------------------- |
| `/dcp` or `/dcp help` | Show command reference                                          |
| `/dcp context`        | Show context window usage and session stats                     |
| `/dcp stats`          | Show pruning statistics (tokens saved, blocks, operations)      |
| `/dcp compress`       | Trigger LLM compression immediately (sends a follow-up message) |
| `/dcp compact`        | Materialize active DCP blocks into a pi-native compaction entry |

## How It Works

### Compression blocks

The live `compress` schema requires a nonempty `ranges` array of `{startId, endId, summary, topic?}`. The top-level `topic` is also optional; omitted topics use `Compressed history`. Summaries are freeform prose. Heading-only calls are no longer part of the live interface. DCP:

1. Resolves visible non-assistant message refs (`m0001`, `m0042`, etc.) and block refs (`b1`, `b3`) through stable internal source/span keys
2. Records the range as a `CompressionBlock` with legacy timestamps plus canonical source-key coverage/anchor metadata when available
3. On every `context` event, splices out the raw messages in that range and prefers source-key placement for anchored blocks, with timestamp fallback for legacy blocks
4. Renders the newest `renderFullBlockCount` blocks with the whole authored summary plus bounded conversation excerpts, aggregate effect counts, and modified-file paths
5. Renders the next `renderCompactBlockCount` blocks with the whole authored summary only; older blocks emit no model-visible block while their covered raw messages stay hidden
6. Persists active summaries and exact coverage for resume; prior authored records remain in append-only saved history even after their latest state entries are retired/slimmed

When a new compression exactly covers an older exact-coverage block, DCP now supersedes the older block instead of accumulating both summaries. Ambiguous partial overlap still rejects conservatively.

By default, DCP also protects the hot tail of the conversation: ranges that end inside the last `protectRecentTurns` logical turns/tool batches are rejected unless the session is already above the hard emergency threshold (`maxContextPercent` or `maxContextTokens`, if configured). When a range is rejected, DCP now includes planning hints that surface the hot-tail start, protected `m0001` / `bN` IDs, and the largest visible safe candidate ranges; the same guidance is appended to live compression nudges.

Message IDs (`m0001`, `m0042`, etc.) are injected only on user/toolResult/bashExecution messages, and block IDs (`b1`, `b3`) are injected on compressed blocks, so the LLM can reference exact compression boundaries without mutating freshly generated assistant output. Assistant turns are selected through surrounding visible boundaries and atomic tool-pair expansion. Internal owner keys are not rendered as model-visible metadata; provider-payload filtering uses canonical source/span/block ownership tracked in state.

The full deterministic record deliberately does not render individual tool calls or commands. `conversation` contains bounded chronological `u:` / `a:` excerpts; `effects` reports only aggregate read, search, mutation, command, and delegation counts; `modified-files` lists bounded unique changed paths. These excerpts are historical quotations, not fresh instructions, and may include abandoned plans or retracted claims. Summary-only records omit all three metadata sections rather than clipping the authored summary.

A `summary` is local memory of the selected stretch, written for a continuing agent that cannot see the replaced messages. Preserve user scope, constraints and corrections; settled decisions and rationale; consequential changes, exact technical references and verification evidence; and what remained unresolved at the stretch's close. Distinguish observed facts from hypotheses, child reports from integrated acceptance, and failed/skipped checks from passes. Prefer useful detail and readable prose to minimum length or glued shorthand. Routine progress narration is not a substitute for the outcome; report paths are not a substitute for critical facts.

Existing blocks can be genuinely consolidated: use `b1` through `b3` to replace several settled records, or `b1` as both boundaries to rewrite just that block. Write the distilled replacement directly; old summaries are not automatically copied into it. Preserve still-relevant restrictions, corrections, evidence and unresolved work. An optional `(bN)` explicitly inserts a fully covered active record verbatim, at most once; unknown, inactive, repeated or out-of-range placeholders reject the whole call. Historical placeholder replay and already stored summaries remain compatible. Qualify superseded conclusions explicitly. Record direction and next actions as they stood at the stretch's close when needed for continuation; later user corrections take precedence. A fresh current orientation is generated only at compaction, not continuously maintained in every block. Recording a blocker or unknown at the end of an otherwise settled investigation is valid; ongoing work whose raw evidence is still needed should stay uncompressed.

Ordinary live blocks with selected boundary IDs render `Record m0003–m0016 (ended <endId ISO timestamp>)` above their summary. Native compaction record rendering omits generated Record headers, including headers expanded from nested blocks; generated section tier/version labels are not needed in model-facing text. Boundary IDs, timestamps, and coverage remain structured bookkeeping. The default model-visible tiers are the newest 4 full records, the next 8 whole-summary-only records, and no rendered block for anything older. `renderFullBlockCount` and `renderCompactBlockCount` configure those existing counts; they do not add a new timer, cadence, or retention knob. An omitted old block still hides its covered raw range, and its canonical authored summary and coverage remain intact in state. Age positions are ranked across the canonical block log, including retired entries: committing a checkpoint cannot promote forgotten older blocks back into view.

### Compaction-only current orientation

There is no mutable live heading, heading-only tool call, heading-age reminder, or ordinary-turn heading injection. At a DCP native checkpoint, a dedicated completion on the working model generates a fresh orientation from the **current effective context, including the recent retained tail**. It states the authorized goal, progress, restrictions/corrections, unresolved issues, and next action. This does not start a recursive main-agent turn or rewrite the historical records. Long tool evidence is not clipped by Pi's ordinary summarization serializer.

Historical heading-bearing state and heading-only tool exchanges remain readable. Old headings are historical input, not automatically current instructions. Existing sessions resume without a new-session requirement, manual conversion, or a storage-schema change for this interface update.

DCP recognizes fo-coding-agent's versioned `sandbox.result` timeline as a container and aggregates its nested operations rather than rendering hundreds of outer `run` calls.

### Native pi compaction

`/dcp compact` asks Pi to create a native compaction entry from DCP state. DCP evaluates `minHiddenCoverageRatio` against the actual hidden range at Pi's unchanged proposed `firstKeptEntryId`; it never advances the cut to improve the ratio. Only exact `coveredSourceKeys` certify coverage. Timestamp intervals remain placement and legacy compatibility data, not omission certification.

At sufficient coverage, the checkpoint contains a fresh current-intent-and-constraints handoff plus the retained DCP records allowed by the ordinary full/summary-only counts. The handoff is generated from the current effective context, including the retained recent tail and later corrections. It replaces accumulated compaction summary state: DCP does not recursively carry `preparation.previousSummary`. Uncovered hidden raw content, including tool evidence, may be omitted from the model checkpoint at this gate; canonical session history remains intact on disk. On commit, all fully hidden exact-coverage blocks are deactivated, including records omitted by aging or budget. This retirement also runs after a seeded host fallback; it does not depend on which records were rendered.

`nativeCompaction.maxSummaryTokens` budgets this checkpoint. DCP first strips optional block metadata, then drops whole oldest retained records until the checkpoint fits; it never clips an authored summary. If the fresh handoff itself is still oversized, DCP falls back to Pi's host summarizer and seeds it by replacing `preparation.previousSummary` with the fresh intent/constraints. Low actual coverage uses the same host fallback. The fallback is not passed through `event.customInstructions`, and prior summaries are not appended recursively. This avoids the former preserve-all budget-cancellation dead end while retaining a fresh statement of current intent.

An unknown host boundary or a failed, empty, or truncated fresh handoff still cancels compaction. Those failures cannot safely seed either path. Auto-trigger timing remains governed by the existing message-count and coverage settings; this contract adds no new timing knobs. `/dcp compact` with no active blocks still skips as a command-level convenience. Disabling DCP or `nativeCompaction.enabled` leaves host compaction unchanged. Compression and checkpointing improve continuation utility but provide no blanket fidelity or losslessness guarantee.

### Atomic tool pair removal

When a compression range touches any part of an assistant→toolResult group, DCP automatically expands the range to include the entire group. This prevents orphaned `tool_use` or `tool_result` blocks that would cause API validation errors. The expansion logic skips over PI-internal passthrough messages (`compaction`, `branch_summary`, `custom_message`) that may sit between an assistant and its tool results. A post-compression repair pass acts as a safety net to catch any orphaned pairs that the expansion heuristics miss.

### Nudge types

| Nudge              | Condition                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **context-strong** | Above `maxContextPercent` OR `maxContextTokens`, after logical-turn debounce / post-compress cool-down, `nudgeForce = "strong"`                   |
| **context-soft**   | Same as above with `nudgeForce = "soft"`                                                                                                          |
| **iteration**      | Between min/max limits, after logical-turn debounce / post-compress cool-down, AND ≥ `iterationNudgeThreshold` tool calls since last user message |
| **turn**           | Between min/max limits, after logical-turn debounce / post-compress cool-down                                                                     |

### Deduplication

An identical request (`toolName::JSON(sorted-args)`) is necessary but insufficient. Visible result content and error status must also match, so two reads of a changed file or a failing then passing command are not duplicates. A newer retained result supplies the evidence before an older result becomes eligible. Images/nontext content and composite outer results are protected from generic whole-result pruning.

### Tool-output eligibility, not automatic age-based deletion

Exact duplicate removal remains deterministic. Separate automatic `purgeErrors` and `customStrategies` clearing/head-tail reduction are retired. Older configuration keys cannot reactivate them; historical saved pruning actions remain readable for session continuity and original-output recovery.

`strategies.candidates` defines a shared minimum age and result size plus extra protected tools. These are review thresholds, not deletion rules. The protected recent tail, protected file patterns, and built-in write/edit/compress/recovery safeguards still apply. An eligible error can be reviewed with its error status supplied, but age or a successful-looking command does not establish that an unresolved failure is disposable.

Unknown tool names are not automatically treated as disposable. Eligible public text can be judged by Jev; private or unsupported output remains protected. No arbitrary first-N/last-N clipping is generated by this policy.

### Containers, exposed fo Refs, and recovery

Outer `run`, `subagent`, and `workflow` results are not treated as generic raw logs. Images and unsupported/nontext results remain protected. Unknown derived outputs, private inner results, mixed authored conclusions, and independent error notices must not be flattened away.

With the optional version-aware fo exposed-Ref bridge, DCP applies exact-result deduplication and shared protection/cadence/savings gates, and offers identifiable **exposed** inner results to Jev review. Explicit live mode can remove those results through the same precise projection. Fo owns canonical Ref enumeration, text projection, and recovery; DCP owns retention selection. No bridge is required for normal Pi. Missing or unsupported bridges leave containers intact rather than guessing from their displayed text.

Use the exact ID in a pruning marker:

```js
dcp_recover({ id: "<recovery ID>", offset: 1, limit: 2000 });
```

Recovery reads the saved original on the current branch; it does not rerun a tool, command, or side effect. IDs may identify an ordinary tool result or a versioned `fo-ref:v1` composite. `offset` is a 1-based text line; `limit` is optional (up to 2000 lines), with a 50,000-character display bound. Follow the returned continuation offset; an overlong single line is saved intact to a recovery file. Canonical originals and images remain intact. Exact fo Ref recovery requires its bridge. A missing original is reported, not recreated by executing the operation again.

### Prefix-cache considerations

Compression, exact duplicate replacement, block aging and provider-payload filtering can change old context. Existing `strategies.pruneCadenceTurns` controls review opportunities; `minPruneItemSavedTokens` and `minPruneBatchSavedTokens` govern exact duplicate and accepted live Jev removals. Cadence counts DCP logical turns, including autonomous tool batches, not just user chat turns. Actual token savings include recovery-marker/projection cost; a candidate must not be mistaken for a committed removal.

Jev in shadow mode changes no model-visible content. In explicitly enabled live mode, accepted asynchronous DROP proposals can commit on the next context pass, after rechecking current eligibility and actual projected net savings. This does not require another cadence to pass. A proposal held below the batch gate is not an applied removal; review and application are distinct.

Native checkpoint timing, block-aging counts and red-zone behavior are unchanged by this simplification.

## Optional Jev review and live pruning

Jev remains disabled by default. Enable observation with `"strategies": { "jev": { "enabled": true } }`. To apply accepted drops, explicitly use `"strategies": { "jev": { "enabled": true, "apply": true } }`, then reload. Existing enabled configurations without `apply: true` remain shadow-only. This sends selected public tool output and recent public conversation through your existing Pi OpenRouter credential to `typesafe/jev-1.13`. Do not enable it where that provider must not receive project data.

### One output per request, each cadence

At each opportunity defined by **`strategies.pruneCadenceTurns`**, gather eligible outputs and process them with bounded parallelism. This is not a hardcoded25-turn interval and not a two-request batch cap. A prior `keep` is asked again in the next cadence. The ledger suppresses duplicate requests within the same cadence, including resume, but is not a cross-cadence relevance cache. Ordinary dialogue arriving while a batch runs does not continually cancel it; each judgment records the snapshot and cadence it evaluated.

Each request contains recent complete public user/assistant conversation plus **one tool's name, arguments, error status, age and full output**. `age_turns` is the batch snapshot's current logical turn minus the result's turn index; exposed inner Refs inherit their outer run's age. It is recorded in the ledger and is context, not proof of obsolescence. Existing summary text can appear as ordinary older background; newer dialogue and corrections take precedence. There is no separate handoff field, semantic task detector or later-observations tracker. Tool payloads, tool-call instructions, thinking and private metadata are not copied into the conversation field.

Conversation selection is bounded in tokens and prefers recent complete messages, rather than collecting all old summaries and rejecting the entire session at8KB. The prompt explicitly says this is partial context and missing information is not evidence that dropping is safe. Oversized artifacts/requests are skipped and audited; output is not clipped to force admission. Eligible public requests are not screened for credential-like text: documentation, example tokens, and tool argument strings are sent unchanged. This is not a data-loss-prevention system; selected public content may contain sensitive data. Private/unexposed content, images, protected tools/files, and token-budget exclusions still apply. Transport credentials and raw transport errors are never written to the audit ledger.

### Keep or drop—not a boolean

The Decisions API question has two choices:

```json
{
  "type": "choice",
  "criteria": {
    "keep": "Useful or potentially needed for the current task; uncertainty means keep.",
    "drop": "Irrelevant or redundant, with no task-critical detail needed in working context."
  }
}
```

This is illustrative; the client supplies the full instructions. A DROP is accepted only when Jev chooses `drop` and `probabilities.drop >= 0.60`. This is an experimental policy threshold, not calibrated accuracy. The separate provider `confidence` is retained as telemetry, not used as a probability gate. Lower probabilities, failures and malformed replies retain the output. No `strong_keep`, retention expiry or automatic summarizer is involved.

**Shadow:** accepted drops are recorded only. **Live:** freshly accepted proposals are revalidated against the current session, candidate identity, exact output and protections, then fed through the existing pruning commit and projection path. Ordinary outputs and exposed fo Refs receive exact-recovery markers; canonical originals are never changed. Error outputs remain protected from live Jev rather than weakening existing error-retention safeguards. Exact dedup stays independent. Network work is nonblocking; failures do not authorize removal.

### Private audit and resume

```text
~/.pi/agent/dcp/jev/<session-id>.jsonl
```

A custom Pi agent directory relocates this subtree. It stays out of session folders and model-visible messages. Records identify the candidate and content, cadence, exact sent conversation/instructions, model/prompt identity, raw and probability-gated judgment, usage/cost/latency when available, and proposal/retention/failure/skip outcomes. Large original outputs remain in canonical session history rather than being duplicated into the ledger. Transport credentials and raw transport failures are not audit data; recorded public conversation is not credential-screened and can still be sensitive, so files are private.

The ledger is an audit and same-cadence retry guard—not permanent `keep` memory or demonstrated pruning safety. Probability-gated records use policy `keep-drop-pdrop-v2` to distinguish older confidence-gated evidence. Application has a separate `applied` audit outcome; a proposal alone is not savings. Historical rows remain readable, but never become prune commands. Pending unapplied judgments are not restored from the ledger; committed pruning selections resume through the existing session state. Later cadences can reevaluate retained outputs.

## Session persistence (direct restore)

Queued changes save on `agent_end` and `session_shutdown` in interactive, RPC, print, and JSON modes when the session API is available. Status updates remain UI-only. Unavailable session APIs leave changes queued; append failures also retain the queue and surface to the host for reporting. Pi's `--no-session` mode remains ephemeral.

DCP restores in-memory compression state from the latest non-unchanged `custom:dcp-state` entry on the active branch. Empty sessions still write a tiny schemaVersion 3 scalar marker. Once blocks exist, DCP writes schemaVersion 5: v3 scalar counters plus active compression blocks with exact `coveredSourceKeys` / `coveredSpanKeys`, source-key anchors, and finite timestamp fallbacks. Inactive blocks are slimmed.

Why this matters in practice:

- Resume does not replay the live context buffer, so post-compaction rebuilt buffers cannot erase active block coverage.
- v1/v5 snapshots restore blocks directly, including old heading-bearing v5 state. Schema v3 scalar bootstraps preserve counters and pruning continuity without inventing blocks. This update needs no conversion/reset/new session and does not change stored shapes.
- Legacy v4 snapshots never stored exact block coverage. The existing compatibility path restores their scalars but cannot restore their missing block coverage; it reports `reset-legacy-v4`. This is a legacy limitation, not a migration introduced by this update.
- Runtime-only tool records are rehydrated from the current source transcript on each context pass, so deduplication and Jev candidate selection continue to recognize pre-restart results.
- `replayDcpState()` remains available for offline scripts such as vacuuming old session JSONL files, where the raw append-only transcript is still present.

Vacuuming is optional disk maintenance, not a prerequisite for resuming an existing session.

### Vacuuming old fat snapshots

Long-lived sessions written before v3 keep their fat block payloads in earlier `dcp-state` lines. Two scripts are bundled to shrink them safely:

```bash
# Re-serialize every dcp-state entry through restore+serialize (writes v3 when empty, v5 when blocks exist).
# Default is dry-run; --write creates a .bak and atomically rewrites the file.
bun run scripts/vacuum-dcp-session.ts <session.jsonl> [--write]

# Same, but walks the whole session tree.
bun run scripts/vacuum-dcp-session.ts --corpus [--session-dir ~/.pi/agent/sessions] [--write]

# Verify-only: replay observables before and after vacuum, assert equivalence.
bun run vacuum:verify-corpus

# Direct-restore-from-serialized-replay equivalence check.
bun run replay:equivalence
```

Verifiers compare four observables across restore paths: `activeBlockIds`, `nextBlockId`, `tokensSaved`, `prunedToolIds`. Replayable sessions must round-trip exactly through serialized direct restore; non-replayable legacy sessions are reported as compatibility notes because replay cannot reconstruct block precision without transcript evidence.

## Status indicator

A `DCP` badge is shown in the pi status bar.

## Development

```bash
bun run test         # Bun test suites under tests/
bun run check-types  # tsc --noEmit
bun run lint         # ESLint
bun run format       # Prettier
bun run ci           # typecheck + lint + tests
```

Pi loads the extension TypeScript directly from `./src/index.ts` — there is no build step for normal development. For normal installs, that extension code runs inside pi's **Node.js** process even though this repo uses **Bun** for local test/dev commands.

The dev Pi SDK (`@earendil-works/pi-ai`, `pi-agent-core`, `pi-coding-agent`, and `pi-tui`) is pinned to **0.87.1** so local checks exercise the target APIs. Pi supplies the imported packages at runtime through broad peers; 0.87.1 is the verified host version (older hosts without `ModelRuntime`/registry completion are not supported by this migration).

### Source layout

```text
src/
  index.ts                 # thin pi extension entrypoint
  types/                   # internal config/state/message/provider contracts
  domain/                  # pure DCP logic: transcript, refs, compression, pruning, nudges, provider filtering
  application/             # pi hook/tool/command orchestration and host payload adaptation
  infrastructure/          # config loading, persistence migration, debug logging
  prompts/                 # system, nudge, and compress-tool prompt text

tests/
  helpers/                 # shared test factories/utilities
  unit/                    # transcript, compression, pruning, nudge, provider-filter tests
  integration/             # applyPruning, compress-tool/debug end-to-end behavior coverage
```

Domain modules should stay pure: no pi API imports, no filesystem/config loading/debug logging side effects, and no application-layer dependencies. Boundary payload narrowing belongs in `src/application/`; durable state/config/message contracts live in `src/types/`.

Do not assume Bun-only runtime APIs such as `bun:ffi` are available inside the extension. If DCP ever needs a Rust performance core, keep the extension shell in TypeScript and integrate Rust via a long-lived sidecar process or a Node native addon.

## Contributors

[![complexthings](https://github.com/complexthings.png?size=50)](https://github.com/complexthings)
[![wassname](https://github.com/wassname.png?size=50)](https://github.com/wassname)

Full contributor list: https://github.com/complexthings/pi-dynamic-context-pruning/graphs/contributors
