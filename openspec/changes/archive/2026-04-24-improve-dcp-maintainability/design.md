## Context

DCP is a pi extension loaded directly from TypeScript. The current runtime path is a hybrid legacy/v2 model: live compression uses `compressionBlocks` with timestamp fallback plus exact source-key metadata, while v2 transcript/materialization scaffolding exists but is not yet the active runtime. The repository currently keeps all runtime modules at the root, uses an executable assert-based `pruner.test.ts`, and has no enforced lint/type/format/pre-commit workflow.

The cleanup must improve maintainability without changing runtime semantics. This matters because future v2 activation will be much safer if current behavior is protected by test tooling and clearer module boundaries first.

## Goals / Non-Goals

**Goals:**

- Introduce a `src/` and `tests/` layout with explicit source/test boundaries.
- Establish layered modules with one-way dependencies: types → domain → application → extension wiring, with infrastructure isolated from pure domain logic.
- Split large files by responsibility while preserving public function behavior and pi extension loading.
- Add internal message/provider/state/config types so `any` is mostly confined to pi/provider boundary adapters.
- Convert the test runner to Bun test and split tests into focused suites over time.
- Add repeatable local quality gates: format, lint, typecheck, test, CI script, and pre-commit checks.
- Keep `.js` local import specifiers and direct TypeScript extension loading compatible with pi.

**Non-Goals:**

- Activating full v2 materialization/runtime semantics.
- Rewriting DCP behavior or persisted state shape.
- Introducing a build step, Turbo, or workspace structure.
- Replacing pure functions with classes or broad framework abstractions.
- Changing user-facing compression, pruning, hot-tail, provider filtering, or saved-token semantics except where tests reveal an existing bug.

## Decisions

### Decision: Use layered directories rather than feature-only folders

DCP SHALL use a layered source layout:

- `src/types/` for internal contracts and boundary types.
- `src/domain/` for pure DCP logic with no pi API, filesystem, or debug logging imports.
- `src/application/` for pi-aware orchestration, tool registration, slash commands, and event handlers.
- `src/infrastructure/` for config loading, persistence, debug logging, and other side effects.
- `src/prompts/` for prompt text and tool descriptions.
- `src/extension.ts` as the thin pi extension entrypoint.

Rationale: DCP has complex domain invariants. Pure domain modules make those invariants easier to test and keep application/provider quirks at the edge. A feature-only layout would not make side-effect boundaries as obvious.

Alternative considered: only move current files under `src/`. This would improve paths but not separation of concerns, so it is insufficient.

### Decision: Preserve behavior during restructuring

The migration SHALL be behavior-preserving. Current tests must continue to pass after each major slice, and runtime state compatibility must be maintained.

Rationale: Combining architecture cleanup with v2 activation would make regressions difficult to diagnose.

Alternative considered: restructure and activate v2 simultaneously. Rejected because v2 changes require separate semantic decisions around source-of-truth, migration, materialization, provider ownership, and compress-only mutation invariants.

### Decision: Confine untyped payloads to application boundaries

Pi/provider event payloads may remain `unknown` or narrowly-cast `any` at the boundary, but domain APIs SHALL accept explicit internal types such as DCP message, content part, tool call, tool result, state, config, and compression metadata types.

Rationale: The extension receives heterogeneous host payloads, but domain code should not need to know host-specific shapes beyond normalized internal contracts.

Alternative considered: fully type all pi/provider payloads up front. Rejected as too risky and likely inaccurate because provider payloads are heterogeneous.

### Decision: Use Bun test as the framework

Tests SHALL use `bun:test` with `describe`/`test`/`expect`, and the current assert script SHALL be converted into named unit/integration suites.

Rationale: Bun is already the project test runtime and provides a real test runner without adding another framework.

Alternative considered: keep the executable assert file. Rejected because it does not give good suite structure, filtering, or standard assertions, and currently contains dead assertions.

### Decision: Add lightweight quality tooling, not a build pipeline

The project SHALL add TypeScript, ESLint, Prettier, Husky, and lint-staged scripts. It SHALL NOT add SWC/Turbo/build output unless a later publishing requirement needs it.

Rationale: Pi loads `.ts` files directly; adding build output now increases maintenance without solving the current problem.

Alternative considered: mirror `context-overflow` wholesale, including Turbo/workspaces/build. Rejected because DCP is a standalone extension.

## Risks / Trade-offs

- **Risk: import-path churn causes runtime load failures** → Keep local `.js` import specifiers, run typecheck/tests after moves, and update `package.json.pi.extensions` in the same slice as entrypoint movement.
- **Risk: strict linting causes a large unrelated cleanup** → Start with practical rules, fail on real issues, and avoid enabling aggressive rules that force noisy behavior changes in the first pass.
- **Risk: type extraction becomes a rewrite** → Introduce minimal internal types first and only tighten as modules are moved behind typed boundaries.
- **Risk: test conversion changes test semantics** → Convert tests mechanically first, then split files; avoid changing expectations except to replace known dead assertions with meaningful checks.
- **Risk: docs drift during migration** → Update README and AGENTS command/path references in the same implementation phase as tooling/layout changes.

## Migration Plan

1. Add `src/` and `tests/`, move files mechanically, update `package.json.pi.extensions`, and keep compatibility exports if needed.
2. Add `tsconfig.json`, package scripts, and Bun test command while preserving current test coverage.
3. Convert the current assert-based test script to Bun test and replace dead assertions.
4. Add ESLint, Prettier, Husky, lint-staged, `.gitignore` hygiene, and a `ci` script.
5. Extract `src/types/*` for config, state, message, and API boundary contracts.
6. Split pure domain modules: transcript, compression range/materialization/supersession, pruning repair/dedup/purge/core, nudges, refs, and provider payload filtering.
7. Split application modules: context/provider/session/tool handlers, compress tool registration/validation/artifacts, commands, lifecycle/persistence orchestration.
8. Update README and AGENTS with new paths, commands, and architecture rules.

Rollback strategy: each phase should be commit-sized and behavior-preserving. If a phase fails, revert that phase without needing persisted-state migration.

## Open Questions

- How strict should ESLint be in the first pass versus deferred cleanup?
- Should full test splitting happen immediately after Bun conversion, or after domain modules are extracted?
- Should compatibility re-export files be kept temporarily at old paths for local developer scripts, or should all imports move in one cutover?
