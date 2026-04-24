## ADDED Requirements

### Requirement: Compression blocks use source-key anchors
The system SHALL place new compressed blocks using durable canonical source or span anchors instead of timestamp-derived insertion points.

#### Scenario: Compressing a middle range
- **WHEN** a compression range covers source items that are followed by another live source item
- **THEN** the created block stores an anchor key that identifies the following source item or equivalent canonical insertion point

#### Scenario: Compressing a trailing range
- **WHEN** a compression range ends at the latest compressible source item
- **THEN** the system stores a valid canonical trailing anchor rather than inventing a numeric timestamp anchor

### Requirement: Anchor resolution uses canonical transcript data
The `compress` tool SHALL resolve range boundaries and insertion anchors from the canonical transcript snapshot and stable alias table.

#### Scenario: Visible refs resolve through alias table
- **WHEN** a `compress` call specifies stable visible message refs
- **THEN** range resolution maps those refs to canonical source keys before determining coverage and anchor placement

#### Scenario: Block refs resolve through active block metadata
- **WHEN** a `compress` call specifies an active block ref as a boundary
- **THEN** range resolution maps the block ref to its canonical covered span and anchor metadata

### Requirement: Legacy timestamp blocks remain readable
The system SHALL retain a conservative fallback path for restored legacy blocks that only have timestamp boundaries.

#### Scenario: Legacy block can be safely applied
- **WHEN** a restored timestamp-based block maps unambiguously to the current canonical transcript
- **THEN** the system may render or migrate it using equivalent source-key coverage

#### Scenario: Legacy block is ambiguous
- **WHEN** a restored timestamp-based block cannot be mapped unambiguously to canonical source keys
- **THEN** the system preserves raw conversation safety by declining unsafe supersession or compression overlap

### Requirement: Supersession uses exact canonical coverage
The system SHALL supersede older blocks only when canonical source/span coverage proves full containment.

#### Scenario: New block fully covers older exact block
- **WHEN** a new compression block covers all source/span keys represented by an older active block
- **THEN** the system may deactivate the older block and record the supersession relationship

#### Scenario: New block partially overlaps older block
- **WHEN** a new compression block partially overlaps an older active block without full canonical containment
- **THEN** the system rejects the compression or requires a safer range rather than silently merging ambiguous coverage
