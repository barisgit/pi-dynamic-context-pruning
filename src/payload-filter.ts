import type { CompressionBlock } from "./state.js"
import type { DcpMessage } from "./types/message.js"
import type { DcpProviderPayloadItem } from "./types/api.js"

function getTextParts(content: unknown): string[] {
  if (typeof content === "string") return [content]
  if (!Array.isArray(content)) return []

  return content.flatMap((part: any) => {
    if (!part || typeof part !== "object") return []
    if (typeof part.text === "string") return [part.text]
    return []
  })
}

export function extractMessageLikeText(message: DcpMessage): string {
  return getTextParts(message?.content).join("\n")
}

function normalizeInlineWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function findLastVisibleMessageRef(text: string): string | null {
  let lastRef: string | null = null
  for (const match of text.matchAll(/<dcp-id>(m\d{3,4})<\/dcp-id>/gi)) {
    if (typeof match[1] === "string") lastRef = match[1].toLowerCase()
  }
  return lastRef
}

function findLastBlockOwnerKey(text: string): string | null {
  let lastOwner: string | null = null
  for (const match of text.matchAll(/<dcp-block-id>(b\d+)<\/dcp-block-id>/gi)) {
    if (typeof match[1] === "string") lastOwner = `block:${match[1].toLowerCase()}`
  }
  return lastOwner
}

export function extractCanonicalOwnerKeyFromMessageLike(
  message: DcpMessage,
  ownerByMessageRef: ReadonlyMap<string, string> = new Map(),
): string | null {
  const normalized = normalizeInlineWhitespace(extractMessageLikeText(message))
  if (!normalized) return null

  const blockOwner = findLastBlockOwnerKey(normalized)
  if (blockOwner) return blockOwner

  const messageRef = findLastVisibleMessageRef(normalized)
  return messageRef ? ownerByMessageRef.get(messageRef) ?? null : null
}

function isMessageLike(item: any): boolean {
  return typeof item?.role === "string"
}

function isMetadataOnlyMessageLike(item: any): boolean {
  const normalized = normalizeInlineWhitespace(extractMessageLikeText(item))
  if (!normalized) return false

  const stripped = normalized
    .replace(/<dcp-id>m\d{3,4}<\/dcp-id>/gi, "")
    .replace(/<dcp-owner>[^<]+<\/dcp-owner>/gi, "")
    .replace(/<dcp-block-id>b\d+<\/dcp-block-id>/gi, "")
    .trim()

  return stripped === "" && /<dcp-id>|<dcp-owner>|<dcp-block-id>/i.test(normalized)
}

function buildDirectOwnerKeys(input: any[], ownerByMessageRef: ReadonlyMap<string, string>): Array<string | null> {
  const owners = input.map((item) =>
    isMessageLike(item) ? extractCanonicalOwnerKeyFromMessageLike(item, ownerByMessageRef) : null,
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
  input: DcpProviderPayloadItem[],
  liveOwnerKeys: Iterable<string>,
  compressionBlocks: readonly CompressArtifactBlock[] = [],
  ownerByMessageRef: ReadonlyMap<string, string> = new Map(),
): DcpProviderPayloadItem[] {
  if (!Array.isArray(input)) return input

  const liveOwners = liveOwnerKeys instanceof Set ? liveOwnerKeys : new Set(liveOwnerKeys)
  if (liveOwners.size === 0) return input

  const directOwners = buildDirectOwnerKeys(input, ownerByMessageRef)
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
