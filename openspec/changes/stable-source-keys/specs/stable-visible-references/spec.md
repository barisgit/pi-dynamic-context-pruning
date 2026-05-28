## MODIFIED Requirements

### Requirement: Stable message references

The system SHALL render model-facing message references as stable session-scoped aliases derived from durable source message keys, and the same logical source message SHALL produce the same visible message reference regardless of which DCP entry point processed it (live context evaluation, replay restore, or any internal recomputation).

#### Scenario: Reference remains stable across context passes

- **WHEN** the same source message is rendered across multiple context passes with pruning or compression changes
- **THEN** the system renders the same visible message reference for that source message each time

#### Scenario: New source message receives next reference

- **WHEN** a source message without an existing alias becomes visible
- **THEN** the system allocates the next available visible message reference and persists the alias mapping

#### Scenario: Reference remains stable across replay restore

- **WHEN** the same logical session message is processed by the live context handler with pi's filtered post-compaction buffer and then by the replay engine walking the full session branch
- **THEN** both paths allocate the same visible message reference for that message, so compress-tool arguments produced by the live agent resolve identically during replay
