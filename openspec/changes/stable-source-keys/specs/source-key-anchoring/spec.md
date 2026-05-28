## MODIFIED Requirements

### Requirement: Anchor resolution uses canonical transcript data

The `compress` tool SHALL resolve range boundaries and insertion anchors from the canonical transcript snapshot and stable alias table, and the source key for a given message SHALL be a deterministic function of the message's own contents (role, timestamp, tool-call id, and a content hash) and SHALL NOT depend on the message's position in any caller-supplied buffer.

#### Scenario: Visible refs resolve through alias table

- **WHEN** a `compress` call specifies stable visible message refs
- **THEN** range resolution maps those refs to canonical source keys before determining coverage and anchor placement

#### Scenario: Block refs resolve through active block metadata

- **WHEN** a `compress` call specifies an active block ref as a boundary
- **THEN** range resolution maps the block ref to its canonical covered span and anchor metadata

#### Scenario: Source key is identical across buffer shapes

- **WHEN** the same logical message is presented inside two buffers of different sizes (for example, the live post-compaction buffer pi delivers versus the full session branch transcript the replay engine walks)
- **THEN** `buildSourceItemKey` returns the same key for that message in both buffers

#### Scenario: Synthetic DCP-rendered messages get a buffer-independent key

- **WHEN** a synthetic message produced by DCP itself is processed (for example, an injected nudge or a materialized `Compressed section: bN` block)
- **THEN** the source key is derived from the message's stable synthetic identity (the nudge turn index or the block id), never from its position in the buffer
