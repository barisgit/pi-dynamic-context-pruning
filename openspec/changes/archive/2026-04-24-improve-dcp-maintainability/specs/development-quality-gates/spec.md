## ADDED Requirements

### Requirement: Standard project scripts
The DCP package SHALL provide standard package scripts for testing, typechecking, linting, formatting, and running all continuous-integration checks locally.

#### Scenario: Contributor runs the full local gate
- **WHEN** a contributor runs the package CI script
- **THEN** the script runs typechecking, linting, and the Bun test suite using the repository's configured tooling

#### Scenario: Existing test command is replaced with framework command
- **WHEN** a contributor runs the package test script
- **THEN** tests execute through Bun's test runner rather than a bespoke executable assert script

### Requirement: Bun test framework
The DCP test suite SHALL use `bun:test` with named suites and assertions, and tests SHALL live under `tests/` with helpers separated from production source.

#### Scenario: Test cases are discoverable by behavior area
- **WHEN** a contributor looks for tests covering transcript, pruning, compression, provider filtering, nudges, or debug logging
- **THEN** tests are organized in named files or suites that correspond to those behavior areas

#### Scenario: Dead assertions are removed
- **WHEN** the current assert-based tests are converted
- **THEN** assertions that always pass, such as empty-string inclusion checks, are replaced by meaningful expectations or removed

### Requirement: TypeScript project configuration
The DCP repository SHALL include a TypeScript project configuration that supports direct TypeScript extension loading, local `.js` import specifiers, strict typechecking, and inclusion of both source and test files.

#### Scenario: Typecheck validates source and tests
- **WHEN** the typecheck script is run
- **THEN** TypeScript checks the `src/` and `tests/` trees without emitting build output

#### Scenario: Import specifiers remain runtime-compatible
- **WHEN** source modules import other local modules
- **THEN** local imports keep `.js` specifiers required by the ESM/pi runtime model while still typechecking successfully

### Requirement: Lint and format tooling
The DCP repository SHALL include ESLint and Prettier configuration suitable for a standalone TypeScript pi extension.

#### Scenario: Lint catches TypeScript quality issues
- **WHEN** the lint script is run
- **THEN** ESLint checks TypeScript source and tests according to the repository configuration and fails on configured warnings or errors

#### Scenario: Format is deterministic
- **WHEN** the format script is run
- **THEN** Prettier formats supported repository files consistently without requiring a build step or monorepo tooling

### Requirement: Pre-commit quality gate
The DCP repository SHALL include a Husky/lint-staged pre-commit workflow that formats staged files and runs relevant lint/type checks before a commit is created.

#### Scenario: Staged TypeScript files are checked
- **WHEN** a contributor commits staged TypeScript changes
- **THEN** the pre-commit hook formats staged files and runs configured lint/type checks for those staged changes

#### Scenario: Full test suite is not required on every commit
- **WHEN** the pre-commit hook runs
- **THEN** it does not need to run the full test suite unless explicitly configured later; the full suite remains available through the CI script

### Requirement: Tooling documentation
The DCP documentation SHALL describe the current source layout, test command, typecheck command, lint command, format command, and pre-commit workflow.

#### Scenario: Agent instructions reflect the new workflow
- **WHEN** an agent reads `AGENTS.md`
- **THEN** it sees the current `src/`/`tests/` layout and the correct commands for tests, typechecking, linting, and formatting

#### Scenario: README reflects user-facing behavior only
- **WHEN** a user reads `README.md`
- **THEN** it describes how to install/use the extension and references current development commands without presenting aspirational v2 behavior as shipped runtime behavior
