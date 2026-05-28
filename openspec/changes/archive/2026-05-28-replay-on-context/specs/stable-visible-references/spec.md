## MODIFIED Requirements

### Requirement: Stable message references

The system SHALL render model-facing message references as stable session-scoped aliases derived from durable source message keys, and the same logical source message SHALL produce the same visible message reference whenever DCP runs over the same in-memory message buffer.

#### Scenario: Reference remains stable across context passes

- **WHEN** the same source message is rendered across multiple context passes with pruning or compression changes
- **THEN** the system renders the same visible message reference for that source message each time

#### Scenario: New source message receives next reference

- **WHEN** a source message without an existing alias becomes visible
- **THEN** the system allocates the next available visible message reference and persists the alias mapping

#### Scenario: Reference remains stable across session restart

- **WHEN** a session restarts and pi delivers its working message buffer to the first `context` event
- **THEN** lazy replay reconstructs visible references against the same buffer the live agent used at compress time, so compress arguments composed before the restart resolve identically after the restart
