# src/domain/transcript/

## Responsibility

Canonical transcript scaffolding: key derivation, span grouping, ownership mapping, and liveness queries used by the active runtime (pruning, nudges, provider-payload filtering), direct-restore coverage metadata, and offline replay tooling.

## Design

**Source-item key chain** (`buildSourceItemKey`):

1. `raw:<id>` — message has durable `id` / `messageId` / `entryId` (e.g. custom messages, replay-synthesized objects)
2. `synth:nudge:<turn>` — stamped by nudge synthesis via `INTERNAL_NUDGE_TURN` Symbol
3. `synth:block:b<id>` — stamped by `renderCompressedBlockMessage` via `INTERNAL_BLOCK_ID` Symbol
4. `msg:<ts>:<role>[:<toolCallId>]:<ordinal>` — timestamp/role fallback; tool-call results append `toolCallId`

Both Symbols are non-enumerable exports retained because the stamping sites are the only callers.

**Span model**: `buildTranscriptSnapshot` produces `TranscriptSourceItem[]` and `TranscriptSpan[]`. Assistant + matching `toolResult`/`bashExecution` pairs (plus trailing passthrough roles) are grouped into one `tool-exchange` span; all other messages are standalone `message` spans.

**Ownership**: `buildSourceOwnerKey(s<ordinal>)` for live source items; `buildBlockOwnerKey(block:b<id>)` for active compression blocks. `buildLiveOwnerKeys` derives the live owner set by computing covered ordinals from exact source/span key metadata first, then falling back to timestamp range for legacy blocks.

## Flow

```text
DcpMessage[]
  └─ buildTranscriptSnapshot
       ├─ map  → TranscriptSourceItem[]   (key via buildSourceItemKey)
       └─ reduce → TranscriptSpan[]        (assistant+tool pairs → tool-exchange span)
```

Consumers: `resolveCompressionBlockCoveredSourceKeys`, `countLogicalTurns`, `resolveLogicalTurnTailStartTimestamp`, `buildLiveOwnerKeys`, offline replay, provider-payload filter.

## Integration

- **Replay** (`src/domain/replay/`): offline reconstruction from transcript + `compress` tool calls using these keys
- **Pruning** (`src/domain/pruning/`): uses `buildLiveOwnerKeys` + covered-ordinal logic
- **Nudge** (`src/domain/nudge/`): uses `resolveLogicalTurnTailStartTimestamp`
- **Provider filter** (`src/domain/provider/`): uses canonical owner keys from this module
- **Persist** (`src/infrastructure/`): v5 persists exact coverage keys for direct restore; v3 remains the scalar-only empty-session marker
