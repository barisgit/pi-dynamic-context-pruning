# DCP restore migration plan

Status: decided (charter dcp-clean-restore). Audience: sole user, local sessions.

## Decision

DCP moves to **direct-restore**: each save persists active compression blocks
with their exact coverage (`coveredSourceKeys`/`coveredSpanKeys`), boundary
anchors (`startSourceKey`/`endSourceKey`/`anchorSourceKey`), real
`startTimestamp`/`endTimestamp`/`anchorTimestamp` (never `Infinity`), and the
`active` flag. On resume, blocks are restored directly from the latest
coverage-bearing `dcp-state` entry. **Replay-on-resume is removed.**
`replayDcpState` survives only as an offline engine for the vacuum/migration
script.

Rationale (proven): block application (`src/domain/pruning/index.ts`
`resolveCompressionRangeForBlock`) resolves ranges from source keys with a
timestamp fallback; `mNNNN` refs are allocated afterward purely for the agent
contract and play no part in placing restored blocks. So a block that restores
with correct coverage anchors prunes correctly with zero replay. The previous
replay-first path recomputed coverage against pi's post-compaction rebuilt
buffer, where original messages are gone, yielding empty coverage and zero
pruning (the ~140k->~285k resume balloon).

## On-disk session shapes and how each is handled

The session `.jsonl` is append-only: even after native compaction, the original
message entries remain physically in the file (compaction appends a summary; it
does not delete prior entries). This is what makes offline migration possible.

| On-disk shape                          | Has usable coverage?                | Resume behavior                  |
| -------------------------------------- | ----------------------------------- | -------------------------------- |
| v1 fat snapshot (pre-v3)               | Yes (`coveredSourceKeys` persisted) | Direct restore works immediately |
| v2 span snapshot (legacy)              | Yes                                 | Direct restore works             |
| v5 fat-light (new)                     | Yes (active blocks carry coverage)  | Direct restore works             |
| v4 light (recent, lossy)               | No (coverage was dropped on save)   | Clean-reset OR opt-in vacuum     |
| v3 scalar marker (empty / replay-only) | No blocks persisted                 | Clean-reset (nothing to restore) |

## Migration approach (chosen): no forced migration

1. **Ship direct-restore.** v1/v5 sessions restore their compression
   automatically — no action needed. The real failing session (all v1 fat
   snapshots) is fixed by this alone.
2. **v4/v3 sessions clean-reset on resume**: they resume uncompressed and are
   immediately recompressable by the agent. Safe and predictable — never throws,
   never silently ships a ballooned transcript with no recovery path.
3. **Opt-in recovery for v4/v3 sessions you care about**: run
   `scripts/vacuum-dcp-session.ts` once over the session. It replays
   `replayDcpState` against the **raw append-only jsonl entries** (which still
   contain the pre-compaction messages), rebuilds exact coverage, and rewrites
   the bootstrap as v5. This is where replay legitimately earns its keep:
   offline, against original messages, not the rebuilt buffer.

Why not force-convert everything: sole user, local files, and v1 and v5 already work.
A blanket migration adds risk for little gain. Clean-reset is the predictable
default; vacuum is the surgical recovery tool.

## Safety guarantees

- Restore never throws on any known on-disk shape.
- Restore never silently ships a ballooned transcript: either compression is
  restored, or the session is visibly uncompressed and recompressable.
- Migration tooling is read-only by default and backs up before rewriting.
- `~/.pi/agent/sessions/` and `~/.pi/log/dcp.jsonl` are never mutated by the
  runtime; only the opt-in vacuum script writes, and only with a backup.
