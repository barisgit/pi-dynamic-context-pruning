## Purpose

Defines the current accepted behavior for `maintainable-extension-architecture`.

## Requirements

### Requirement: Layered source layout
The DCP codebase SHALL place runtime TypeScript source under `src/` and organize modules into explicit architectural layers for types, domain logic, application orchestration, infrastructure side effects, prompts, and extension entrypoint wiring.

#### Scenario: Runtime source is not flat at repository root
- **WHEN** a contributor inspects the repository source layout
- **THEN** runtime TypeScript modules are grouped under `src/` by responsibility instead of existing as unrelated root-level files

#### Scenario: Pi extension entrypoint is explicit
- **WHEN** pi loads the package extension from `package.json`
- **THEN** the configured extension path points to the new `src/` entrypoint

### Requirement: One-way dependency direction
The DCP codebase SHALL enforce a dependency direction where domain modules do not import application modules, pi extension APIs, infrastructure side-effect modules, or filesystem/debug logging utilities.

#### Scenario: Domain logic remains pure
- **WHEN** a domain module implements transcript, compression, pruning, nudge, or visible-ref behavior
- **THEN** it operates on typed inputs and returns values without reading files, writing logs, registering pi hooks, or importing `ExtensionAPI`

#### Scenario: Application layer adapts host events
- **WHEN** a pi hook, tool call, provider request, or slash command is handled
- **THEN** application-layer code normalizes boundary payloads and delegates pure decisions to domain modules

### Requirement: Split pruning responsibilities
The DCP codebase SHALL split pruning responsibilities into focused modules for pruning orchestration, compression block application, tool-exchange repair, deduplication, purge policies, nudge policy, nudge rendering, and visible ID injection.

#### Scenario: Tool-exchange atomicity is maintained after split
- **WHEN** a compression range covers part of an assistant tool-call exchange
- **THEN** the split pruning modules still remove or preserve the assistant/tool-result exchange atomically without orphaned tool calls or results

#### Scenario: Independent pruning policies are testable
- **WHEN** a contributor changes deduplication, purge, repair, or nudge behavior
- **THEN** the relevant policy can be tested through a focused module without constructing the full pi extension runtime

### Requirement: Split compression tool responsibilities
The DCP codebase SHALL split compression tool implementation into pi tool registration, range validation, artifact construction, exact coverage metadata, supersession planning, and pure compression range helpers.

#### Scenario: Range helpers are shared without importing pruner orchestration
- **WHEN** compression validation needs range resolution or expansion logic
- **THEN** it imports pure compression range helpers rather than importing the pruning orchestrator

#### Scenario: Compression artifacts preserve exact metadata
- **WHEN** a new compression block is created through the split tool implementation
- **THEN** it still records exact covered source keys, covered span keys, source-key anchors, saved-token estimates, and represented compress call IDs where available

### Requirement: Explicit internal type boundaries
The DCP codebase SHALL define internal TypeScript contracts for config, state, messages, content parts, tool records, provider payload boundaries, compression blocks, and transcript spans, and SHALL confine untyped host payload handling to application boundary adapters.

#### Scenario: Domain functions use internal message types
- **WHEN** a domain function processes conversation messages
- **THEN** its public signature uses internal DCP message/content types rather than unconstrained `any[]`

#### Scenario: Boundary adapters handle heterogeneous host payloads
- **WHEN** the extension receives pi or provider payloads whose exact shape is not fully controlled by DCP
- **THEN** application-layer adapters perform the required narrowing or normalization before invoking domain logic

### Requirement: Behavior-preserving architecture migration
The maintainability migration SHALL preserve current DCP runtime semantics, persisted-state compatibility, local `.js` import specifiers, and direct TypeScript loading by pi.

#### Scenario: Current regression suite still passes
- **WHEN** source files are moved or split during the migration
- **THEN** existing compression, pruning, transcript, provider filtering, hot-tail, supersession, and debug-log regression tests continue to pass

#### Scenario: Full v2 activation is deferred
- **WHEN** the layered architecture migration is implemented
- **THEN** the live runtime continues to use the current legacy compression block path with exact metadata enhancements rather than switching `compressionBlocksV2` to the primary source of truth
