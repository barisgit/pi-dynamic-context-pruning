## 1. State and Alias Foundations

- [x] 1.1 Add persisted stable message alias state to `state.ts` and migration normalization in `migration.ts`.
- [x] 1.2 Implement helpers for formatting/parsing stable message refs and block refs, accepting transitional legacy refs where needed.
- [x] 1.3 Allocate message refs from durable source/raw keys during transcript/context processing and persist the alias mapping.
- [x] 1.4 Add tests proving the same source message keeps the same visible ref across repeated context passes and pruning changes.

## 2. Visible Protocol Cleanup

- [x] 2.1 Update `pruner.ts` ID injection so model-facing transcript renders stable message refs and block refs only.
- [x] 2.2 Remove visible source owner metadata from rendered messages and compressed block output.
- [x] 2.3 Update `prompts.ts` to describe `m0001`-style refs and `bN` block refs as the only compression boundary protocol.
- [x] 2.4 Add regression tests asserting rendered model-facing transcript text does not contain owner markers.

## 3. Internal Ownership and Provider Filtering

- [x] 3.1 Refactor ownership derivation so canonical live owner keys are produced from transcript/source/span/block state rather than visible text tags.
- [x] 3.2 Update `payload-filter.ts` to filter provider artifacts using internal source/span/tool/block ownership maps.
- [x] 3.3 Preserve filtering of stale `reasoning`, `function_call`, and `function_call_output` artifacts for compressed tool exchanges.
- [x] 3.4 Ensure failed or unrepresented `compress` calls are not suppressed by provider filtering.
- [x] 3.5 Add tests for user-authored DCP-like tags and repeated generated owner-like tags proving they do not assign ownership.

## 4. Source-Key Anchoring

- [x] 4.1 Add source-key anchor metadata for new compression blocks while retaining legacy timestamp fields for fallback.
- [x] 4.2 Update `compress-tool.ts` range resolution to map visible refs through the stable alias table into canonical source/span keys.
- [x] 4.3 Replace new-block timestamp anchor creation with source-key/trailing-anchor placement.
- [x] 4.4 Update compression block application/materialization to place source-key anchored blocks deterministically.
- [x] 4.5 Add tests for middle-range compression, trailing-range compression, and no invented numeric timestamp anchors.

## 5. Legacy Compatibility and Supersession

- [x] 5.1 Implement conservative migration/fallback behavior for restored timestamp-only blocks.
- [x] 5.2 Ensure stale or unresolved visible IDs are rejected with actionable errors.
- [x] 5.3 Keep exact-coverage supersession behavior for fully covered older blocks.
- [x] 5.4 Add tests rejecting partial ambiguous overlap and `bN..bN` ranges that contain no raw source messages.

## 6. Hallucination Hardening

- [x] 6.1 Add generated-output DCP tag stripping/ignoring helpers in `dcp-metadata.ts` or a dedicated metadata hygiene module.
- [x] 6.2 Apply generated-tag stripping/ignoring before assistant/tool/subagent output can affect ownership, range resolution, or provider filtering.
- [x] 6.3 Preserve literal user-authored text while ensuring DCP-like tags inside user text are not treated as metadata.
- [x] 6.4 Add a regression fixture for the repeated `<parameter name="owner">...` protocol-leak failure mode.

## 7. Verification and Documentation

- [x] 7.1 Update `README.md` and `AGENTS.md` to describe stable visible refs, internal ownership, and source-key anchoring.
- [x] 7.2 Run `bun run pruner.test.ts` and fix regressions.
- [x] 7.3 Run `tsc --noEmit --module esnext --moduleResolution bundler --target es2022 --skipLibCheck *.ts` and fix type errors.
- [x] 7.4 Add a short migration note documenting legacy timestamp/ref compatibility and rollback expectations.
