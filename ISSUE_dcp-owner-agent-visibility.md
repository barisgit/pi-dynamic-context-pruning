# Issue: stop rendering `dcp-owner` tags into the agent-facing transcript

## Summary

DCP currently renders both visible boundary IDs and canonical owner tags into ordinary message content:

- `<dcp-id>mNNN</dcp-id>`
- `<dcp-owner>sN</dcp-owner>`

The `dcp-id` tag is agent-facing and useful for compression boundaries.
The `dcp-owner` tag is internal bookkeeping for provider-payload filtering.

In practice, the owner tag is usually rendered immediately next to the visible ID on almost every eligible message. In a real proxy capture (`/Users/blaz/.pi/tmp/llm-proxy/2026-04-23T10-43-49_openai_3.json`), these tags appear one after another throughout the transcript. That adds noise, spends tokens, and may confuse the agent into treating internal ownership markers as part of the user contract.

## Why this is a problem

Current repo invariants already distinguish the two concepts:

- visible `mNNN` / `bN` markers are for the agent/tool contract
- canonical owner keys (`s0`, `s1`, `block:b1`) are internal bookkeeping

Relevant references:

- `AGENTS.md`
- `codemap.md`
- `DCP_V2_DESIGN.md`

Today, however, `pruner.ts` injects both into rendered message text in `injectMessageIds(...)`, so the internal marker leaks into the agent-visible transcript.

## Current behavior

### Rendering

`pruner.ts`:
- `applyPruning(...)` attaches a non-enumerable internal owner key per source message via `buildSourceOwnerKey(ordinal)`
- `injectMessageIds(...)` then renders both:
  - `<dcp-id>...</dcp-id>`
  - `<dcp-owner>...</dcp-owner>`

### Consumption

`payload-filter.ts` currently extracts canonical ownership from rendered message-like text via:
- `<dcp-owner>...</dcp-owner>` for live source messages
- `<dcp-block-id>...</dcp-block-id>` for compressed blocks

That ownership is used to prune stale hidden/provider artifacts:
- `reasoning`
- `function_call`
- `function_call_output`

`index.ts` wires this through `buildLiveOwnerKeys(...)` + `filterProviderPayloadInput(...)`.

## Desired outcome

Keep canonical ownership semantics, but stop exposing `dcp-owner` to the agent by default.

The agent should still see:
- `dcp-id` for raw visible message boundaries
- `dcp-block-id` / block markers as needed for compressed-block references

The agent should not need to see:
- `dcp-owner`
- source owner keys like `s0`, `s1`, etc.

## Constraint

Do **not** regress hidden-artifact liveness/filtering.

The internal requirement remains valid:
- stale provider payload artifacts must still be pruned deterministically according to canonical source/block ownership
- we must not fall back to naive visibility heuristics

## Likely direction

Preferred direction: separate **rendered agent-facing metadata** from **internal ownership metadata**.

Possible implementation paths:

1. **Best path:** stop relying on rendered `dcp-owner` text for payload filtering
   - keep owner information in a non-agent-facing structure or reconstruct it from canonical transcript state
   - let `payload-filter.ts` use canonical ownership without scanning agent-visible text for `dcp-owner`

2. **Intermediate path:** scrub/unrender `dcp-owner` before sending transcript to the agent, but preserve enough metadata for provider filtering elsewhere

## Safety requirement for any scrub/unrender approach

Do **not** remove arbitrary user-authored text that merely contains the literal string `<dcp-owner>`.

If we strip rendered tags, the removal must be narrowly targeted to DCP-injected metadata only.

A safe rule would be something like:
- only strip exact DCP metadata segments
- only when they appear in the injected trailing metadata position
- only for roles/shapes DCP itself annotates
- do not strip inline/body text that a real user or tool produced intentionally

## Important observation

These tags are currently injected at the end of annotated messages, which makes suffix-based removal plausible.
That said, any implementation should treat this as an invariant that needs tests, not as an assumption.

## Suggested acceptance criteria

- `dcp-owner` is no longer visible in normal agent-facing transcript content
- `dcp-id` remains visible and usable for compression boundaries
- provider payload filtering still correctly prunes stale `reasoning`, `function_call`, and `function_call_output`
- no fallback to visibility-derived ownership heuristics
- legitimate message content containing literal `dcp-owner` text is preserved
- tests cover both string content and array/block content shapes
- docs are updated anywhere that currently implies `dcp-owner` is part of the visible agent contract

## Likely files to touch

- `pruner.ts`
- `payload-filter.ts`
- `index.ts`
- `transcript.ts`
- `prompts.ts`
- `pruner.test.ts`
- possibly `AGENTS.md` / `README.md` / `codemap.md` if user-visible semantics change

## Notes

This aligns with the v2 design direction in `DCP_V2_DESIGN.md`: keep internal bookkeeping deterministic, but keep the prompt/rendered transcript simpler.
