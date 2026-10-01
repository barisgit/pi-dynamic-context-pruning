# Changelog

## Unreleased

- Added opt-in age masking (`strategies.ageMasking.enabled`, default `false`): successful text tool outputs and exposed fo Refs older than `strategies.candidates.minAgeTurns` are replaced by exact `dcp_recover` markers through the existing eligibility, item/batch savings gates, projection and persistence. Errors, images, containers and authored `run` text, mutations, DCP tools and AGENTS.md/CLAUDE.md/SKILL.md reads are kept.

- Added explicitly opt-in live Jev removals (`strategies.jev.apply: true`) through existing protection, projection, net-savings and recovery paths, including exposed fo Refs. Existing enabled configurations remain shadow-only without this flag. Pending judgments are never loaded as prune commands from old audit rows.
- Replaced the DROP confidence-margin gate with explicit `P(drop) >= 0.60`; confidence remains telemetry, not a safety guarantee. Errors remain protected from live Jev in this initial policy.

- Added genuine agent-authored consolidation of one or several existing compression blocks. Mandatory verbatim reinsertion is removed; explicit quotations remain validated and historical replay stays compatible. Exact coverage, protected tails and canonical originals are preserved.
- Removed unused native fallback instructions and forwarding modules; actual host fallback still receives the fresh handoff through its existing preparation field.

- Simplified Jev to keep/drop decisions, recent public dialogue, all eligible outputs with bounded parallelism, and reevaluation every configured cadence. Audit suppresses same-cadence duplicates rather than caching relevance indefinitely.
- Retired deterministic error purging and custom age-only clear/head-tail rules. Shared candidate age/size/protection settings replace those rules; exact-result deduplication and existing savings gates remain. Historical saved actions/configuration stay readable without re-enabling retired collectors.

- Added opt-in, disabled-by-default Jev shadow judgments for eligible exposed tool outputs. Decisions are audited outside session folders under the agent directory `dcp/jev/`; shadow mode never changes pruning selections.
- Promoted the typed Decisions API client from evaluation scripts into runtime infrastructure; evaluation imports remain compatible. Existing OpenRouter credentials are reused.

## [2.0.0] - 2026-09-20

### Changed

- New `compress` calls require nonempty `ranges`, with optional topics and freeform summaries. Live heading updates are removed; native compaction generates a fresh working-model handoff using the effective context and recent tail.
- Block retention is staged by the existing count settings: newest blocks retain full presentation, the next tier retains intact authored summaries without conversation/effect/file metadata, and older blocks leave working context entirely. Canonical originals remain saved.
- Native checkpoints validate the actual boundary, use the existing coverage gate, and retain budgeted memory with a fresh handoff. Whole old blocks may be omitted instead of cancelling because all history cannot fit. Existing host summarization remains the fallback; no separate asynchronous summarizer is introduced.
- Historical saved state and heading-bearing calls remain readable automatically. Persisted schema versions are unchanged; no manual conversion or fresh session is required. Pruning and native trigger timing remain unchanged. Retention is deliberately lossy, not a guarantee that every old instruction survives.

### Fixed

- Prevented final-cut omissions, age/budget clipping of authored memory, repeated-checkpoint duplication, and serialization of private tool details into checkpoint model text.
- Deduplication requires identical visible results as well as requests. Old errors require retained successful retries; differing results and unresolved errors survive.

### Added

- Optional fo exposed-Ref bridge: precise public text-result pruning, exact recovery IDs, combined actual savings gates, and conservative protection of ambiguous, image-bearing, private, and derived output. Existing savings and cadence configuration is retained.
- `dcp_recover` reads canonical current-branch originals without rerunning operations, with paged text and exact large-output files.
- Repeated-cycle continuation harness and bounded Jev, selective-summary, and timing trials. Experimental mechanisms are not enabled as production defaults.

## [1.0.7] - 2026-04-14

### Fixed

- **Infinity anchorTimestamp ghost block spiral** — When a `compress` range extended to the end of the conversation, `resolveAnchorTimestamp` returned `Infinity`. `JSON.stringify(Infinity)` serialises to `null`, so on session restore the corrupted block's timestamps coerced to `0` in JS overlap checks, making every new range appear to overlap the ghost block and trapping the model in a compression spiral (101 failures over 2 hours). `resolveAnchorTimestamp` now returns `endTimestamp + 1` instead of `Infinity`.
- **Corrupted block propagation on session restore** — `index.ts` now filters out any persisted compression block whose `startTimestamp`, `endTimestamp`, or `anchorTimestamp` is non-finite before restoring state, preventing ghost blocks from surviving across sessions.
- **Non-finite timestamp guard** — All code paths that create or apply compression blocks now validate timestamps are finite before proceeding, failing fast rather than silently corrupting state.
- **Overlap error diagnostics** — Overlap error messages now include the existing block's timestamp range to aid debugging.
- **Prompt tag name mismatch** — The prompt tag was named `<dcp-message-id>` but the code injected `<dcp-id>`; tag name corrected to `<dcp-id>` throughout `prompts.ts`.
- **Duplicate test** — Removed a duplicate test case from `pruner.test.ts`.

### Added

- **Regression tests** — New test cases for the `Infinity` anchor scenario, `null`-timestamp corrupted blocks, and corrupted-block resilience on session restore.

Thanks to [@wassname](https://github.com/wassname) for diagnosing and fixing the compression spiral root cause in [#3](https://github.com/complexthings/pi-dynamic-context-pruning/pull/3).

## [1.0.6] - 2026-04-09

### Fixed

- **Orphaned tool_use/tool_result after compression** — Compression ranges that touched part of an assistant→toolResult group could leave orphaned `tool_use` or `tool_result` blocks, causing Anthropic API 400 errors (`unexpected tool_use_id found in tool_result blocks`). The backward and forward expansion logic now correctly skips PI-internal passthrough roles (`compaction`, `branch_summary`, `custom_message`) when scanning for paired messages, ensuring atomic removal of complete tool groups.
- **Content mutation across context events** — `applyPruning` now deep-clones message content instead of shallow-copying, preventing injected `dcp-id` blocks from accumulating on shared message objects across successive context events.

### Added

- **Post-compression repair function** — `repairOrphanedToolPairs` runs after all compression blocks are applied as a safety net. It removes orphaned `toolResult`/`bashExecution` messages whose `toolCallId` has no matching `toolCall` in any assistant message, and strips orphaned `toolCall` blocks from assistant messages whose results no longer exist.
- **New test cases** — Tests 5–9 covering passthrough role handling (backward and forward expansion), content mutation isolation, multi-block orphan repair, and direct orphan cleanup.

## [1.0.5] - 2026-04-06

### Fixed

- Prevent orphaned tool_use blocks from compression and harden autocomplete.

## [1.0.4] - 2026-04-05

### Fixed

- Tool crash on compression.

## [1.0.3] - 2026-04-04

### Fixed

- Various errors and issues.

## [1.0.2] - 2026-04-03

### Changed

- Added pi package details to package.json.

## [1.0.1] - 2026-04-02

### Added

- Initial release.
