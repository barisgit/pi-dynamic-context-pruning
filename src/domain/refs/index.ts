// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) — visible reference helpers
// ---------------------------------------------------------------------------

const MESSAGE_REF_WIDTH = 4;
const MESSAGE_REF_MIN_INDEX = 1;
const STABLE_MESSAGE_REF_REGEX = /^m(\d{4,})$/i;
const LEGACY_MESSAGE_REF_REGEX = /^m(\d{3})$/i;
const BLOCK_REF_REGEX = /^b([1-9]\d*)$/i;

export type ParsedVisibleRef =
  | { kind: "message"; ref: string; index: number; legacy: boolean }
  | { kind: "block"; ref: string; blockId: number };

export interface MessageAliasState {
  bySourceKey: Map<string, string>;
  byRef: Map<string, string>;
  nextRef: number;
}

export interface MessageRefSnapshotEntry {
  ref: string;
  sourceKey: string;
  timestamp: number | null;
  ownerKey: string;
}

export function createMessageAliasState(): MessageAliasState {
  return {
    bySourceKey: new Map(),
    byRef: new Map(),
    nextRef: MESSAGE_REF_MIN_INDEX,
  };
}

export function formatMessageRef(index: number): string {
  if (!Number.isInteger(index) || index < MESSAGE_REF_MIN_INDEX) {
    throw new Error(
      `Message ID index out of bounds: ${index}. Supported range starts at ${MESSAGE_REF_MIN_INDEX}.`
    );
  }
  return `m${String(index).padStart(MESSAGE_REF_WIDTH, "0")}`;
}

export function formatBlockRef(blockId: number): string {
  if (!Number.isInteger(blockId) || blockId < 1) {
    throw new Error(`Invalid block ID: ${blockId}`);
  }
  return `b${blockId}`;
}

export function parseVisibleRef(rawRef: string): ParsedVisibleRef | null {
  const normalized = rawRef.trim().toLowerCase();

  const stableMessageMatch = normalized.match(STABLE_MESSAGE_REF_REGEX);
  if (stableMessageMatch) {
    const index = Number.parseInt(stableMessageMatch[1]!, 10);
    return { kind: "message", ref: formatMessageRef(index), index, legacy: false };
  }

  const legacyMessageMatch = normalized.match(LEGACY_MESSAGE_REF_REGEX);
  if (legacyMessageMatch) {
    const index = Number.parseInt(legacyMessageMatch[1]!, 10);
    return { kind: "message", ref: `m${legacyMessageMatch[1]}`, index, legacy: true };
  }

  const blockMatch = normalized.match(BLOCK_REF_REGEX);
  if (blockMatch) {
    const blockId = Number.parseInt(blockMatch[1]!, 10);
    return { kind: "block", ref: formatBlockRef(blockId), blockId };
  }

  return null;
}

export function allocateMessageRef(aliases: MessageAliasState, sourceKey: string): string {
  const existing = aliases.bySourceKey.get(sourceKey);
  if (existing) {
    if (aliases.byRef.get(existing) !== sourceKey) aliases.byRef.set(existing, sourceKey);
    return existing;
  }

  let candidate = Number.isInteger(aliases.nextRef)
    ? Math.max(MESSAGE_REF_MIN_INDEX, aliases.nextRef)
    : MESSAGE_REF_MIN_INDEX;

  while (true) {
    const ref = formatMessageRef(candidate);
    if (!aliases.byRef.has(ref)) {
      aliases.bySourceKey.set(sourceKey, ref);
      aliases.byRef.set(ref, sourceKey);
      aliases.nextRef = candidate + 1;
      return ref;
    }
    candidate++;
  }
}

export function normalizeMessageAliasState(value: unknown): MessageAliasState {
  const aliases = createMessageAliasState();
  if (!value || typeof value !== "object") return aliases;

  const raw = value as Record<string, unknown>;
  const bySourceKey = raw.bySourceKey;
  const byRef = raw.byRef;

  if (bySourceKey && typeof bySourceKey === "object") {
    for (const [sourceKey, refValue] of Object.entries(bySourceKey as Record<string, unknown>)) {
      if (typeof refValue !== "string") continue;
      const parsed = parseVisibleRef(refValue);
      if (!parsed || parsed.kind !== "message" || parsed.legacy) continue;
      aliases.bySourceKey.set(sourceKey, parsed.ref);
      aliases.byRef.set(parsed.ref, sourceKey);
    }
  }

  if (byRef && typeof byRef === "object") {
    for (const [refValue, sourceKeyValue] of Object.entries(byRef as Record<string, unknown>)) {
      if (typeof sourceKeyValue !== "string") continue;
      const parsed = parseVisibleRef(refValue);
      if (!parsed || parsed.kind !== "message" || parsed.legacy) continue;
      aliases.byRef.set(parsed.ref, sourceKeyValue);
      aliases.bySourceKey.set(sourceKeyValue, parsed.ref);
    }
  }

  aliases.nextRef =
    typeof raw.nextRef === "number" && Number.isInteger(raw.nextRef)
      ? Math.max(MESSAGE_REF_MIN_INDEX, raw.nextRef)
      : inferNextRef(aliases);

  return aliases;
}

function inferNextRef(aliases: MessageAliasState): number {
  let max = 0;
  for (const ref of aliases.byRef.keys()) {
    const parsed = parseVisibleRef(ref);
    if (parsed?.kind === "message" && !parsed.legacy) max = Math.max(max, parsed.index);
  }
  return Math.max(MESSAGE_REF_MIN_INDEX, max + 1);
}

export function serializeMessageAliasState(aliases: MessageAliasState): {
  bySourceKey: Record<string, string>;
  byRef: Record<string, string>;
  nextRef: number;
} {
  return {
    bySourceKey: Object.fromEntries(aliases.bySourceKey),
    byRef: Object.fromEntries(aliases.byRef),
    nextRef: aliases.nextRef,
  };
}
