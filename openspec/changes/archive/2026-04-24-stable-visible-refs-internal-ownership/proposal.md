## Why

DCP currently mixes model-facing compression refs with internal ownership metadata, which creates protocol leakage risk and lets generated text influence provider-payload ownership decisions. The next architecture step is to make stable visible refs (`m0001`, `b3`) the only model-facing DCP protocol while moving ownership, liveness, and block placement to canonical internal source/span keys.

## What Changes

- **BREAKING**: Replace rotating 3-digit message refs with stable session-scoped visible refs such as `m0001`, while preserving `bN` block refs for compressed blocks.
- Remove visible owner metadata from rendered transcript text; the model should never need or see owner markers.
- Anchor compression blocks to durable raw/source message keys instead of visible ordinal snapshots or timestamp math.
- Preserve internal canonical ownership for provider payload filtering using source keys, span keys, tool-call IDs, and block IDs.
- Harden provider payload filtering so generated or user-authored DCP-like tags are not treated as authoritative ownership.
- Add migration and validation paths for existing timestamp/visible-ID based blocks.

## Capabilities

### New Capabilities
- `stable-visible-references`: Defines the model-facing compression reference contract for stable message refs and block refs.
- `internal-ownership`: Defines invisible canonical ownership and provider filtering behavior without visible owner tags.
- `source-key-anchoring`: Defines compression block placement and range validation using durable source/span anchors instead of timestamps.

### Modified Capabilities

None; no existing OpenSpec capabilities are present in `openspec/specs/`.

## Impact

- Affected runtime modules: `pruner.ts`, `compress-tool.ts`, `transcript.ts`, `payload-filter.ts`, `state.ts`, `migration.ts`, `index.ts`, `prompts.ts`.
- Affected tests: `pruner.test.ts` and any new focused tests for stable refs, owner leakage, provider filtering, and migration.
- Affected persisted state: new alias maps and source-key anchors are added; timestamp-based blocks remain migration/fallback inputs only.
- Affected agent contract: agents keep using visible refs for `compress`, but owner metadata is removed from the visible transcript.
