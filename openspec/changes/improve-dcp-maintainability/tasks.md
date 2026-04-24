## 1. Tooling Baseline

- [x] 1.1 Add `tsconfig.json` that typechecks `src/**/*.ts` and `tests/**/*.ts` without emitting build output.
- [x] 1.2 Add package scripts for `test`, `test:watch`, `check-types`, `lint`, `format`, and `ci`.
- [x] 1.3 Add development dependencies for Bun test types, TypeScript, ESLint, Prettier, Husky, lint-staged, and related TypeScript ESLint config.
- [x] 1.4 Add ESLint configuration for standalone TypeScript source/tests with practical initial rules.
- [x] 1.5 Add Prettier configuration and ignore rules for generated or dependency directories.
- [x] 1.6 Add Husky/lint-staged pre-commit configuration that formats staged files and runs staged TypeScript checks.
- [x] 1.7 Add `.gitignore` hygiene for local temp/build/tooling artifacts such as `tmp/`, `dist/`, `.turbo/`, and TypeScript build info.

## 2. Mechanical Layout Migration

- [x] 2.1 Create `src/` and move production TypeScript files from the repository root into `src/` without behavior changes.
- [x] 2.2 Create `tests/` and move `pruner.test.ts` under the test tree.
- [x] 2.3 Update `package.json` pi extension entry from the root entrypoint to the new `src/` entrypoint.
- [x] 2.4 Update source/test imports after the move while preserving local `.js` specifiers for runtime-compatible ESM imports.
- [x] 2.5 Run the existing test command and typecheck after the mechanical move to verify behavior is unchanged.

## 3. Bun Test Conversion

- [ ] 3.1 Convert the current executable assert-based tests to `bun:test` suites using `describe`, `test`, and `expect`.
- [ ] 3.2 Replace dead assertions such as empty-string inclusion checks with meaningful expectations.
- [ ] 3.3 Split helper factories and fixtures out of test cases where doing so improves readability without changing covered behavior.
- [ ] 3.4 Verify `bun test` passes and covers the same DCP behaviors as the previous `bun run pruner.test.ts` command.

## 4. Type Boundary Extraction

- [ ] 4.1 Create `src/types/config.ts` and move or re-export DCP config interfaces from the current config module.
- [ ] 4.2 Create `src/types/state.ts` and move DCP state, compression block, metadata, tool record, persisted-state, and alias/snapshot interfaces.
- [ ] 4.3 Create `src/types/message.ts` with minimal internal DCP message, content part, tool call, and tool result contracts.
- [ ] 4.4 Create `src/types/api.ts` for pi/provider boundary shapes that are known enough to type safely.
- [ ] 4.5 Update domain-facing function signatures to prefer internal types over unconstrained `any[]`, while keeping unknown host payload handling at application boundaries.
- [ ] 4.6 Run typecheck and tests after type extraction to catch import and narrowing regressions.

## 5. Domain Module Split

- [ ] 5.1 Create `src/domain/transcript/` and move transcript snapshot, logical-turn, span coverage, and owner-key derivation helpers into focused modules.
- [ ] 5.2 Create `src/domain/refs/` and move visible ref parsing, formatting, allocation, alias normalization, and message ID injection logic.
- [ ] 5.3 Create `src/domain/compression/` and move block factories, materialization, range resolution/expansion, exact coverage helpers, and supersession planning.
- [ ] 5.4 Create `src/domain/pruning/` and split pruning orchestration, compression block application, tool-exchange repair, deduplication, error purging, and tool-output pruning.
- [ ] 5.5 Create `src/domain/nudge/` and split nudge policy/debounce decisions from nudge rendering/injection.
- [ ] 5.6 Move provider payload filtering into an appropriate pure domain owner/provider module while keeping provider event adaptation outside domain.
- [ ] 5.7 Ensure domain modules do not import pi API types, filesystem utilities, config loading, debug logging, or application handlers.
- [ ] 5.8 Run tests after each major domain split and preserve current compression/pruning/provider semantics.

## 6. Application and Infrastructure Split

- [ ] 6.1 Create `src/infrastructure/` modules for config loading, debug logging, and persisted-state read/write helpers.
- [ ] 6.2 Create `src/prompts/` modules for system prompt text, nudge prompt text, and compress tool description text.
- [ ] 6.3 Create `src/application/context-handler.ts` for context-pass orchestration over typed domain functions.
- [ ] 6.4 Create `src/application/provider-handler.ts` for before-provider-request payload adaptation and provider filtering.
- [ ] 6.5 Create `src/application/session-handler.ts` and related lifecycle helpers for session start/shutdown/end state handling.
- [ ] 6.6 Create `src/application/tool-recording.ts` for tool call/result tracking and error-purge bookkeeping.
- [ ] 6.7 Split compress tool code into registration, validation, and artifact-construction modules under `src/application/compress-tool/`.
- [ ] 6.8 Move slash command registration under `src/application/commands/dcp.ts`.
- [ ] 6.9 Reduce the pi entrypoint to thin wiring that registers tools, commands, and hook handlers.

## 7. Focused Test Suite Split

- [ ] 7.1 Split transcript and logical-turn tests into `tests/unit/transcript.test.ts`.
- [ ] 7.2 Split compression range, artifact, and supersession tests into `tests/unit/compression.test.ts`.
- [ ] 7.3 Split pruning repair, dedup, purge, and nudge tests into focused pruning/nudge unit suites.
- [ ] 7.4 Split provider payload filtering tests into `tests/unit/provider-payload-filter.test.ts`.
- [ ] 7.5 Keep end-to-end `applyPruning` and compress-tool behavior coverage under `tests/integration/`.
- [ ] 7.6 Add or preserve tests proving runtime behavior remains unchanged after module splitting.

## 8. Documentation and Verification

- [ ] 8.1 Update `README.md` with current development commands and the direct TypeScript pi extension entrypoint.
- [ ] 8.2 Update `AGENTS.md` with the new module map, layer rules, command list, and common edit targets.
- [ ] 8.3 Update or archive stale research notes that conflict with the new authoritative architecture documentation.
- [ ] 8.4 Run `bun run ci` and confirm typecheck, lint, and Bun tests pass.
- [ ] 8.5 Verify pi can still load the extension from the configured `src/` entrypoint.
