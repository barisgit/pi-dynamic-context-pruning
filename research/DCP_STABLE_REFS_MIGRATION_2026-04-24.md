# DCP stable refs / source-key anchors migration note

Date: 2026-04-24
Change: `stable-visible-refs-internal-ownership`

## What changed

- New model-facing message refs render as stable 4-digit aliases such as `m0001`.
- Compressed block refs remain `bN`.
- Visible source owner tags are no longer rendered into model-facing transcript content.
- DCP persists a source-key alias table so the same source message keeps the same visible ref across context passes.
- New compression blocks keep legacy timestamp fields plus optional `startSourceKey`, `endSourceKey`, and `anchorSourceKey` metadata.

## Compatibility

- Legacy 3-digit refs such as `m001` are still accepted as transitional aliases when they exist in the latest rendered snapshot.
- Timestamp-only compression blocks remain readable and use the existing conservative timestamp fallback path.
- Source-key anchored blocks are preferred for new compression placement; if an anchor cannot be resolved, DCP falls back to legacy timestamp ordering rather than guessing.

## Rollback expectations

The change is additive in persisted state:

- `messageAliases` can be ignored by older code.
- optional source-key fields on `CompressionBlock` can be ignored by older code.
- timestamp fields are still present on legacy blocks.

If rollback is needed, disable source-key placement first while keeping visible owner tags removed and hallucination stripping enabled; those two changes reduce protocol leakage and are safe independently.
