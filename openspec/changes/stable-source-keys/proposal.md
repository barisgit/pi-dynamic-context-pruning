## Why

`buildSourceItemKey` falls back to `msg:${timestamp}:${role}:${ordinal}` when a
message has no `.id` / `.messageId` / `.entryId`. The ordinal is the message's
position in the buffer passed to `applyPruning`. Two DCP entry points hand
that builder two different buffers for the same logical message:

- **Live runtime** receives pi's already-filtered, post-compaction message
  buffer (a few hundred messages, low ordinals).
- **Replay** walks the FULL session JSONL branch from the beginning (thousands
  of entries, high ordinals).

Same message → different ordinal → different source-key → different `mNNNN`
allocation. Compress arguments the live agent emitted (e.g. `m1547..m1612`)
fail to resolve during replay because replay never allocates those refs. We
silently drop ranges and lose blocks across session restart. Measured on a
real session: 11 of 31 ranges dropped, 6 active blocks → 0 after restart,
context window 89k → 206k+ tokens.

Recon during the design phase confirmed pi's `ContextEvent` does not carry
`branchEntries` and pi's `AgentMessage` shape (`UserMessage`,
`AssistantMessage`, `ToolResultMessage`) has no durable entry id. The pi
entry id only reaches DCP via `session_*` events, not via the per-pass
`context` event. So source-keys cannot depend on a pi-supplied id.

Source-keys must instead be a deterministic function of the message itself —
something both buffers can compute identically without coordination.

## What Changes

- Change `buildSourceItemKey` to derive the key from `(role, timestamp,
  toolCallId, contentHash)` instead of `(timestamp, role, [toolCallId],
  ordinal)`. The ordinal argument goes away.
- `contentHash` is a sha256 of `JSON.stringify(message.content)`, take the
  first 16 hex chars. Cheap (~20 μs per message); only computed during the
  source-key build (i.e. each `context` pass per message).
- Synthetic DCP-rendered messages keep their existing buffer-independent
  identity (`synth:nudge:<turn>`, `synth:block:b<id>`); the deterministic
  primary path catches everything else.
- Keep the `raw:<id>` short-circuit for the rare case a pi message arrives
  with an `id`/`messageId`/`entryId` already on it (custom_message entries,
  future API additions). Unchanged.
- Update / add tests pinning the new contract: identical source-keys for the
  same message in any buffer; replay's `state.messageRefSnapshot` is
  membership-equivalent to live's for the same branch.
- **BREAKING (internal)**: source-keys for ordinal-fallback messages change
  shape. The agent does NOT see source-keys; it sees `mNNNN`/`bN` refs which
  remain unchanged. Acceptable because:
  - `dcp-replay-v3` already made the persisted snapshot a tiny scalar
    bootstrap (no `coveredSourceKeys` are persisted any more).
  - Replay reconstructs blocks from scratch, so the coverage arrays it
    produces use the new keys uniformly.
  - Live runtime always rebuilds source-keys on each `context` pass.
  - Pre-v3 fat snapshots remain readable via the snapshot fallback path;
    their legacy source-keys keep working because that path bypasses the
    new builder.

## Capabilities

### New Capabilities

(none — this change tightens existing requirements)

### Modified Capabilities

- `stable-visible-references`: tighten "Reference remains stable across
  context passes" so stability explicitly extends across restore / replay
  boundaries, not just sequential context passes inside one session.
- `source-key-anchoring`: tighten "Anchor resolution uses canonical
  transcript data" so source-keys must be a deterministic function of the
  message itself (role, timestamp, tool-call id, content hash) and must NOT
  depend on the position of a message in any caller-supplied buffer.

## Impact

- `src/domain/transcript/index.ts` — `buildSourceItemKey` signature and body;
  add a small sha256 content-hash helper colocated with the only caller.
- `src/domain/pruning/index.ts` — call site of `buildSourceItemKey` inside
  `injectMessageIds`; drop the ordinal argument. The enclosing
  `for (let ordinal = 0; ...)` loop stays for owner-key allocation and the
  assistant tool-call insert-position logic.
- `src/domain/replay/index.ts` — no changes required: replay already calls
  `applyPruning` end-to-end; once the key function is deterministic the
  refs align without further wiring.
- `src/application/context-handler.ts` — no changes required: pi's
  `ContextEvent.messages` is the only input we need.
- `tests/unit/transcript.test.ts`, `tests/unit/replay.test.ts`,
  `tests/integration/legacy-session-restore.test.ts`,
  `tests/unit/compression.test.ts` — pin the deterministic-key contract.
- No public API, agent-facing protocol, config, or persisted-state surface
  changes. No new dependencies (sha256 is from `node:crypto`).
- Removes the *primary* motivation for `legacyAssistantRefs` (ordinal-driven
  replay/live drift). The option stays for the narrow assistant-id inclusion
  case; default may flip to `false` once test 8.1 in `tasks.md` confirms.
