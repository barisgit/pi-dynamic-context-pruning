import type { CompressionBlock } from "./state.js"

function getTextParts(content: unknown): string[] {
  if (typeof content === "string") return [content]
  if (!Array.isArray(content)) return []

  return content.flatMap((part: any) => {
    if (!part || typeof part !== "object") return []
    if (typeof part.text === "string") return [part.text]
    return []
  })
}

export function extractMessageLikeText(message: any): string {
  return getTextParts(message?.content).join("\n")
}

function normalizeInlineWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

type CanonicalOwnerMarker = {
  ownerKey: string
  index: number
}

function findLastCanonicalOwnerMarker(text: string): CanonicalOwnerMarker | null {
  let lastOwnerMarker: CanonicalOwnerMarker | null = null
  for (const match of text.matchAll(/<dcp-owner>([^<]+)<\/dcp-owner>/g)) {
    const ownerKey = match[1]
    const index = match.index
    if (typeof ownerKey === "string" && typeof index === "number") {
      lastOwnerMarker = { ownerKey, index }
    }
  }

  let lastBlockMarker: CanonicalOwnerMarker | null = null
  for (const match of text.matchAll(/<dcp-block-id>(b\d+)<\/dcp-block-id>/g)) {
    const blockId = match[1]
    const index = match.index
    if (typeof blockId === "string" && typeof index === "number") {
      lastBlockMarker = { ownerKey: `block:${blockId}`, index }
    }
  }

  if (!lastOwnerMarker) return lastBlockMarker
  if (!lastBlockMarker) return lastOwnerMarker
  return lastBlockMarker.index > lastOwnerMarker.index ? lastBlockMarker : lastOwnerMarker
}

export function extractCanonicalOwnerKeyFromMessageLike(message: any): string | null {
  const normalized = normalizeInlineWhitespace(extractMessageLikeText(message))
  if (!normalized) return null

  return findLastCanonicalOwnerMarker(normalized)?.ownerKey ?? null
}

function isMessageLike(item: any): boolean {
  return typeof item?.role === "string"
}

function isMetadataOnlyMessageLike(item: any): boolean {
  const normalized = normalizeInlineWhitespace(extractMessageLikeText(item))
  if (!normalized) return false

  const stripped = normalized
    .replace(/<dcp-id>m\d+<\/dcp-id>/g, "")
    .replace(/<dcp-owner>[^<]+<\/dcp-owner>/g, "")
    .trim()

  return stripped === "" && /<dcp-id>|<dcp-owner>/.test(normalized)
}

function buildDirectOwnerKeys(input: any[]): Array<string | null> {
  const owners = input.map((item) =>
    isMessageLike(item) ? extractCanonicalOwnerKeyFromMessageLike(item) : null,
  )

  for (let i = 0; i + 1 < input.length; i++) {
    const current = input[i]
    const next = input[i + 1]
    if (!isMessageLike(current) || !isMessageLike(next)) continue
    if (owners[i] !== null || owners[i + 1] === null) continue
    if (current.role !== next.role) continue
    if (!isMetadataOnlyMessageLike(next)) continue

    owners[i] = owners[i + 1]
  }

  return owners
}

function buildPreviousAssistantOwners(
  input: any[],
  directOwners: Array<string | null>,
): Array<string | null> {
  const owners: Array<string | null> = new Array(input.length).fill(null)
  let previousAssistantOwner: string | null = null

  for (let i = 0; i < input.length; i++) {
    const item = input[i]
    owners[i] = previousAssistantOwner

    if (!isMessageLike(item)) continue
    if (item.role === "user") {
      previousAssistantOwner = null
      continue
    }
    if (item.role === "assistant" && directOwners[i]) {
      previousAssistantOwner = directOwners[i]
    }
  }

  return owners
}

function buildNextAssistantOwners(
  input: any[],
  directOwners: Array<string | null>,
): Array<string | null> {
  const owners: Array<string | null> = new Array(input.length).fill(null)
  let nextAssistantOwner: string | null = null

  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i]
    owners[i] = nextAssistantOwner

    if (!isMessageLike(item)) continue
    if (item.role === "user") {
      nextAssistantOwner = null
      continue
    }
    if (item.role === "assistant" && directOwners[i]) {
      nextAssistantOwner = directOwners[i]
    }
  }

  return owners
}

type CompressArtifactBlock = Pick<CompressionBlock, "id" | "active" | "compressCallId">

function buildRepresentedCompressCallIds(
  liveOwnerKeys: Set<string>,
  compressionBlocks: readonly CompressArtifactBlock[],
): Set<string> {
  const compressCallIds = new Set<string>()

  for (const block of compressionBlocks) {
    if (!block.active) continue
    if (typeof block.compressCallId !== "string") continue
    if (!liveOwnerKeys.has(`block:b${block.id}`)) continue
    compressCallIds.add(block.compressCallId)
  }

  return compressCallIds
}

function isRedundantCompressArtifact(item: any, representedCompressCallIds: Set<string>): boolean {
  if (representedCompressCallIds.size === 0) return false

  if (item?.type === "function_call") {
    return item?.name === "compress" && typeof item.call_id === "string" && representedCompressCallIds.has(item.call_id)
  }

  if (item?.type === "function_call_output") {
    return typeof item.call_id === "string" && representedCompressCallIds.has(item.call_id)
  }

  return false
}

export function filterProviderPayloadInput(
  input: any[],
  liveOwnerKeys: Iterable<string>,
  compressionBlocks: readonly CompressArtifactBlock[] = [],
): any[] {
  if (!Array.isArray(input)) return input

  const liveOwners = liveOwnerKeys instanceof Set ? liveOwnerKeys : new Set(liveOwnerKeys)
  if (liveOwners.size === 0) return input

  const directOwners = buildDirectOwnerKeys(input)
  const previousAssistantOwners = buildPreviousAssistantOwners(input, directOwners)
  const nextAssistantOwners = buildNextAssistantOwners(input, directOwners)
  const representedCompressCallIds = buildRepresentedCompressCallIds(liveOwners, compressionBlocks)

  return input.filter((item, index) => {
    if (isRedundantCompressArtifact(item, representedCompressCallIds)) {
      return false
    }

    if (isMessageLike(item)) {
      const owner = directOwners[index]
      return owner === null ? true : liveOwners.has(owner)
    }

    if (item?.type === "reasoning") {
      const owner = nextAssistantOwners[index] ?? previousAssistantOwners[index]
      return owner === null ? true : liveOwners.has(owner)
    }

    if (item?.type === "function_call" || item?.type === "function_call_output") {
      const owner = previousAssistantOwners[index] ?? nextAssistantOwners[index]
      return owner === null ? true : liveOwners.has(owner)
    }

    return true
  })
}
