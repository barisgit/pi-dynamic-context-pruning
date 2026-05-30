# src/domain/provider/

## Responsibility

Prune stale `reasoning`, `function_call`, and `function_call_output` artifacts from the provider payload so the model does not see hidden or superseded content. Provider-payload filtering is architecturally separate from visible transcript rendering.

## Design

### Owner key derivation — primary path (a236b59)

Assistant messages carry `__dcpOwnerKey` (a Symbol-keyed property) on the in-memory `DcpMessage` object, set by `src/domain/transcript/` at snapshot build time. `extractCanonicalOwnerKeyFromMessageLike` reads this Symbol first:

```text
in-memory assistant message → __dcpOwnerKey (Symbol) → owner key string
```

This sidesteps rendering/parsing entirely and preserves the last-turn prefix-cache (assistant DCP-ID tags were dropped from rendered output in a236b59).

### Owner key derivation — fallback path

Regex fallbacks exist only for non-assistant messages and legacy payloads that may not yet carry `__dcpOwnerKey`:

| Source pattern      | Derived owner key                 |
| ------------------- | --------------------------------- |
| `bN</dcp-block-id>` | `block:bN`                        |
| `mNNNN</dcp-id>`    | lookup in `ownerByMessageRef` map |

### Represented compress receipts

Active `CompressionBlock`s with `compressCallId` and a live `block:bN` owner key are grouped by call ID. The newest receipt is minified to a compact success message; older receipts for the same call are suppressed. See `buildRepresentedCompressArtifacts`.

### Payload item ownership

| Item type                                               | Owner source                                                               |
| ------------------------------------------------------- | -------------------------------------------------------------------------- |
| `reasoning`                                             | `nextAssistantOwners` → `previousAssistantOwners` (lookahead chain)        |
| `function_call` / `function_call_output` (non-compress) | `previousAssistantOwners` → `nextAssistantOwners`                          |
| compress represented pair                               | replaced by receipt or suppressed (never dropped entirely when successful) |
| user/assistant message                                  | `directOwners`; never pruned by this module (visible layer)                |
| pi-native compaction summary                            | always kept                                                                |

## Flow

```text
provider payload items
  → buildDirectOwnerKeys / buildPreviousAssistantOwners / buildNextAssistantOwners
  → buildRepresentedCompressArtifacts  (live blocks → call-id → receipt/newest)
  → for each item: check owner vs liveOwnerKeys set
      └── owned  → keep (possibly minified)
      └── not owned → drop
```

## Integration

- **Called from:** `src/application/provider-handler.ts` — receives the raw provider payload array and `liveOwnerKeys` (a `Set<string>` of canonical owner keys from `src/domain/transcript/`)
- **Depends on:** `src/domain/transcript/` for `__dcpOwnerKey` injection and `liveOwnerKeys` population
- **Input:** raw provider payload items, live owner key set, active compression blocks (for represented compress logic)
- **Output:** filtered array with stale artifacts removed and newest compress pair minified to a receipt
