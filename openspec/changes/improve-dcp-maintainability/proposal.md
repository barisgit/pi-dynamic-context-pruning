## Why

DCP has grown into a working extension, but its flat source layout, ad-hoc test runner, missing quality gates, and weak internal type boundaries make further v2 work risky and harder to review. Before changing runtime semantics, the project needs a maintainable architecture and tooling baseline that preserves current behavior while making future changes safer.

## What Changes

- Move runtime code into a layered `src/` structure with explicit domain, application, infrastructure, prompt, and type boundaries.
- Split large mixed-responsibility modules into focused modules for pruning, compression, transcript handling, refs, nudges, provider filtering, commands, and pi hook orchestration.
- Move tests into `tests/` and convert the executable assert script into Bun test suites with focused unit/integration coverage.
- Add project quality tooling: TypeScript config, ESLint, Prettier, package scripts, and Husky/lint-staged pre-commit checks.
- Strengthen type safety by introducing internal message/provider/state/config types and confining `any`/unknown pi payload handling to application boundary adapters.
- Preserve current runtime behavior and persisted-state compatibility during the cleanup; full v2 activation remains a separate change.

## Capabilities

### New Capabilities
- `maintainable-extension-architecture`: Covers the layered source layout, dependency direction, module responsibilities, and type-safety boundaries for DCP internals.
- `development-quality-gates`: Covers test framework, lint/typecheck/format scripts, and pre-commit checks for safe local development.

### Modified Capabilities

None. There are no existing OpenSpec capabilities in this repository yet.

## Impact

- Affected code: all root TypeScript modules will move under `src/` and be split along clearer concern boundaries.
- Affected tests: `pruner.test.ts` will move under `tests/` and be converted to Bun test APIs.
- Affected package metadata: `package.json` will point pi to the new extension entrypoint and add development scripts/dependencies.
- Affected docs: README and AGENTS guidance will need updated paths, commands, and architecture notes.
- Compatibility: runtime behavior, pi extension loading, local `.js` import specifiers, persisted state shape, and current compression semantics must remain compatible during this refactor.
