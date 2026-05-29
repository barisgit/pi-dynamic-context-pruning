## ADDED Requirements

### Requirement: Persisted block metadata survives session restart

The system SHALL persist enough CompressionBlock metadata in dcp-state entries so that on session restart, `state.compressionBlocks` is restored to the same set of block records (id, topic, summary, active flag, savings estimates, supersession graph) the live session had at the most recent save.

#### Scenario: v4 dcp-state entry round-trips block list

- **WHEN** a session writes a v4 dcp-state entry with N blocks (some active, some deactivated by native compaction)
- **THEN** restoring from that entry produces a `state.compressionBlocks` array with the same N blocks, preserving id, topic, summary, active flag, createdAt, savedTokenEstimate, summaryTokenEstimate, compressCallId, and metadata.supersededBlockIds

#### Scenario: Pre-compaction blocks survive into a second compaction

- **WHEN** a session experiences a native compaction (baking blocks b1..bK into the compaction summary), restarts, and triggers a second native compaction
- **THEN** the second compaction's tier rendering has access to all blocks b1..bN (active and previously deactivated), including pre-compaction blocks the live message buffer can no longer reach

#### Scenario: v3 legacy sessions still use lazy replay

- **WHEN** a session restores from a v3 dcp-state entry (no persisted block array)
- **THEN** restoreStateFromBranch sets `state.replayPending = true` and the first context event runs lazy replay against the live buffer

#### Scenario: Persistence budget stays bounded

- **WHEN** a session writes a v4 dcp-state entry with up to 100 blocks
- **THEN** the serialized JSON stays under 30 KB (~300 bytes per block worst case), and per-snapshot size scales linearly with block count
