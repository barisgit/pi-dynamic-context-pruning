## ADDED Requirements

### Requirement: Ownership is internal and canonical
The system SHALL track source, span, tool, provider artifact, and block ownership using internal canonical keys rather than model-visible owner text.

#### Scenario: Source ownership is available without visible tags
- **WHEN** a rendered transcript message corresponds to a canonical source item or span
- **THEN** the system can determine its internal owner key without reading a visible owner tag from the transcript text

#### Scenario: Block ownership is available without visible owner tags
- **WHEN** a compressed block is active
- **THEN** the system can determine the block's covered source keys, span keys, and block owner key from persisted state

### Requirement: Provider payload filtering uses internal liveness
Provider payload filtering SHALL remove stale hidden/provider artifacts based on canonical live owner keys produced by the active transcript/materialization pipeline.

#### Scenario: Artifact owner is compressed
- **WHEN** a provider artifact is owned by a source or span that is fully covered by an active compression block
- **THEN** provider payload filtering removes or suppresses that artifact from the outbound provider request

#### Scenario: Artifact owner is live
- **WHEN** a provider artifact is owned by a source or span that remains live in the rendered transcript
- **THEN** provider payload filtering preserves that artifact unless another configured filter applies

### Requirement: Visible text is not authoritative ownership
The system SHALL NOT treat arbitrary model-visible text containing DCP-like tags as authoritative ownership metadata.

#### Scenario: User quotes a DCP-like tag
- **WHEN** a user message contains text that resembles a DCP owner or block metadata tag
- **THEN** the system preserves the user text as conversation content but does not use it to assign ownership

#### Scenario: Assistant hallucinates DCP-like tags
- **WHEN** generated assistant, tool, or subagent output contains DCP-like metadata tags
- **THEN** the system strips or ignores those tags before they can influence ownership, range resolution, or provider filtering

### Requirement: Provider filtering remains correct after owner tag removal
The system SHALL preserve stale provider artifact pruning behavior after visible owner metadata is removed.

#### Scenario: Compressed tool exchange removes stale provider artifacts
- **WHEN** a tool exchange is compressed and its raw source/span keys are no longer live
- **THEN** associated provider `reasoning`, `function_call`, and `function_call_output` artifacts are filtered without relying on visible owner tags

#### Scenario: Failed or unrepresented compression attempts remain visible
- **WHEN** a `compress` tool call fails or is not represented by a live rendered block
- **THEN** its provider artifacts are not suppressed as if they were already represented by a compressed summary
