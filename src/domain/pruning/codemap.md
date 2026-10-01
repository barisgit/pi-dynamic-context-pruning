# src/domain/pruning/

## Responsibility

Materialize the model-visible context without changing canonical messages: replace compressed ranges with retained block summaries, apply exact dedup and explicitly accepted live Jev removals, preserve assistant/tool pairing, and inject stable visible IDs.

## Flow

`applyPruning` clones/stamps source ownership, removes generated DCP artifacts, counts logical turns and replaces covered ranges with active blocks according to the existing retention tiers. `finalizeMaterializedMessages` repairs orphaned tool pairs, builds optional fo Ref contexts, commits eligible selections through `commitHeuristicPruning`, projects ordinary and Ref tombstones, garbage-collects dead selections, and injects visible IDs.

The two stamp/strip passes also support callers that enter through finalization directly. Do not collapse those entry points without testing their distinct caller obligations.

## Decisions and savings

- Exact duplicates require identical request fingerprint, full visible content and error status, with a newer copy retained.
- Live Jev proposals arrive from application scheduling as exact candidate-id/artifact pairs. Current eligibility, content and protections are rechecked. Error outputs are excluded from these live proposals; historical error restoration remains separate.
- Optional age masking (`strategies.ageMasking.enabled`, default off) selects successful text outputs and exposed, non-error fo Refs whose shared candidate eligibility passes (`candidates.minAgeTurns` against the closed cadence bucket). It adds fixed protections for `apply_patch` and AGENTS.md/CLAUDE.md/SKILL.md reads to the shared collector's container/write/edit/compress/recovery exclusions, and joins dedup in the same commit. Outer run text, out() text and other derived content stay.
- Accepted Jev decisions do not remove output immediately in the async callback. They join the same commit and actual-projection savings calculation on a subsequent context pass. The application receives only IDs actually committed by Jev, not coincident dedup commits.
- Item and batch gates use configured values (package defaults25/100; the user's overrides100/10000). Fo savings include every exposed copy and recovery-marker costs, measured on the final projection. Existing red-zone behavior bypasses savings gates, not content protections.
- Cadence uses DCP logical turns. Age is eligibility, not proof of obsolescence. Deprecated error-purge/custom collectors cannot create new selections.

## Ref and recovery invariants

Outer containers, images, unsupported/ambiguous output, private inner results and derived text remain protected. The optional fo bridge enumerates only attributable public Refs and projects all copies consistently. Missing bridges fail closed. Tombstones identify `dcp_recover`; originals and assistant/tool pairs stay canonical. Applied IDs/actions persist through the existing session format; transient uncommitted Jev proposals do not.

## IDs and ownership

Only user/toolResult/bashExecution messages receive `mNNNN` IDs; compressed records receive `bN`. Source/owner keys are structured bookkeeping, not model-visible tags. Provider payload filtering uses the canonical owner map. Block rewriting preserves exact coverage, not the generated historical Record label.

## Entry points

- `application/context-handler.ts`: hydration, runtime bridge and accepted Jev proposals, materialization, scheduling.
- `application/session-handler.ts`: restored-state materialization.
- `application/compress-tool/registration.ts`: context limits and planning.
- `domain/provider/payload-filter.ts`: canonical live ownership.
- `getNudgeType` remains exported from this module; the unused forwarding directory was removed.
