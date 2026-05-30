# dcp-persistence Specification

## Purpose

Defines the accepted behavior for DCP persisted `dcp-state`. On restart, the latest coverage-bearing entry (v1/v2/v5) restores `state.compressionBlocks` directly; non-compressing sessions restore scalar continuity only; persistence stays bounded. DCP writes v3 scalar-only markers when no blocks exist and v5 coverage-bearing snapshots once blocks exist. Legacy v4 (lossy) and v2 remain readable for backward compatibility but are never written; v5 is the first correct persisted shape.

## Requirements

### Requirement: Persisted block metadata survives session restart

The system SHALL persist enough CompressionBlock metadata in dcp-state entries so that on session restart, `state.compressionBlocks` is restored directly from the latest coverage-bearing state entry with the same block records and coverage anchors the live session had at the most recent save.

#### Scenario: v5 dcp-state entry round-trips coverage-bearing block list

- **WHEN** a session writes a v5 dcp-state entry with N active blocks
- **THEN** restoring from that entry produces a `state.compressionBlocks` array with the same N blocks, preserving id, topic, summary, active flag, createdAt, savedTokenEstimate, summaryTokenEstimate, compressCallId, source-key anchors, finite timestamp fallback, and coverage metadata including `coveredSourceKeys` and `coveredSpanKeys`

#### Scenario: Pre-compaction blocks survive into a second compaction

- **WHEN** a session experiences a native compaction (baking blocks b1..bK into the compaction summary), restarts, and triggers a second native compaction
- **THEN** the second compaction's tier rendering has access to all blocks b1..bN (active and previously deactivated), including pre-compaction blocks the live message buffer can no longer reach

#### Scenario: Scalar-only entries do not resurrect blocks

- **WHEN** a session restores without a coverage-bearing v1, v2, or v5 dcp-state entry
- **THEN** restoreStateFromBranch restores scalar continuity from the latest dcp-state entry but does not resurrect compression blocks or schedule replay on the first context event

#### Scenario: Persistence budget stays bounded

- **WHEN** a session writes a v5 dcp-state entry with up to 100 blocks
- **THEN** the serialized JSON stores direct-restore coverage in one bounded block list, and per-snapshot size scales linearly with block count
