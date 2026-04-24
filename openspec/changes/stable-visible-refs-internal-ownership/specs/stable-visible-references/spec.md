## ADDED Requirements

### Requirement: Stable message references
The system SHALL render model-facing message references as stable session-scoped aliases derived from durable source message keys.

#### Scenario: Reference remains stable across context passes
- **WHEN** the same source message is rendered across multiple context passes with pruning or compression changes
- **THEN** the system renders the same visible message reference for that source message each time

#### Scenario: New source message receives next reference
- **WHEN** a source message without an existing alias becomes visible
- **THEN** the system allocates the next available visible message reference and persists the alias mapping

### Requirement: Visible compression refs are the only model-facing DCP protocol
The system SHALL expose only message refs and block refs needed for compression range selection to the model-facing transcript.

#### Scenario: Agent selects a compression range
- **WHEN** the agent needs to call the `compress` tool
- **THEN** it can identify raw messages by stable `m0001`-style refs and compressed blocks by `bN` refs

#### Scenario: Internal owner metadata is absent
- **WHEN** the model-facing transcript is rendered
- **THEN** it does not contain visible source owner metadata or owner-key tags

### Requirement: Boundary ID validation
The `compress` tool SHALL validate message and block boundary IDs against the current stable alias table and active block table.

#### Scenario: Valid IDs resolve to canonical targets
- **WHEN** a `compress` call uses visible refs that exist in the current alias/block tables
- **THEN** the system resolves them to canonical source or block targets before range validation

#### Scenario: Stale IDs are rejected
- **WHEN** a `compress` call uses a message ref or block ref that cannot be resolved
- **THEN** the system rejects the request with an actionable error that identifies the unresolved ID

### Requirement: Transitional legacy ID parsing
The system SHALL support a migration period where legacy message refs can be parsed without making legacy refs the preferred rendered format.

#### Scenario: Legacy ref resolves during migration
- **WHEN** an existing session or test uses a legacy `mNNN` ref that exists in the compatibility alias table
- **THEN** the system resolves it to the same canonical target as the stable alias

#### Scenario: New prompt contract uses stable refs
- **WHEN** DCP prompt/tool documentation is rendered for new sessions
- **THEN** examples use stable `m0001`-style message refs and `bN` block refs
