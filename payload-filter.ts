import { createHash } from "node:crypto"

const COMPACTION_PREFIX = "The conversation history before this point was compacted into the following summary:"

function normalizeInlineWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function hashText(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12)
}

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

function extractVisibleKey(role: string | null, text: string): string | null {
  const normalized = normalizeInlineWhitespace(text)
  if (!normalized) return null

  const blockMatch = normalized.match(/<dcp-block-id>(b\d+)<\/dcp-block-id>/)
  if (blockMatch) return `block:${blockMatch[1]}`

  const messageMatch = normalized.match(/<dcp-id>(m\d+)<\/dcp-id>/)
  if (messageMatch) return `msg:${messageMatch[1]}`

  if (normalized.startsWith(COMPACTION_PREFIX)) {
    return `compaction:${hashText(normalized.slice(0, 1024))}`
  }

  if (!role) return null
  return `text:${role}:${hashText(normalized)}`
}

export function extractVisibleKeyFromMessageLike(message: any): string | null {
  const role = typeof message?.role === "string" ? message.role : null
  return extractVisibleKey(role, extractMessageLikeText(message))
}

function isVisiblePayloadAnchor(item: any): boolean {
  return typeof item?.role === "string" && extractVisibleKeyFromMessageLike(item) !== null
}

function buildRenderedVisibleKeySet(messages: any[]): Set<string> {
  const keys = new Set<string>()
  for (const message of messages) {
    const key = extractVisibleKeyFromMessageLike(message)
    if (key) keys.add(key)
  }
  return keys
}

interface PayloadBundle {
  items: any[]
  visibleKeys: Set<string>
}

function buildPayloadBundles(input: any[]): PayloadBundle[] {
  const bundles: PayloadBundle[] = []
  let current: PayloadBundle | null = null

  for (const item of input) {
    const startsNewBundle =
      typeof item?.role === "string" &&
      item.role === "user" &&
      isVisiblePayloadAnchor(item)

    if (!current || startsNewBundle) {
      current = {
        items: [],
        visibleKeys: new Set<string>(),
      }
      bundles.push(current)
    }

    current.items.push(item)

    const key = extractVisibleKeyFromMessageLike(item)
    if (key) current.visibleKeys.add(key)
  }

  return bundles
}

export function filterProviderPayloadInput(input: any[], renderedMessages: any[]): any[] {
  if (!Array.isArray(input) || renderedMessages.length === 0) return input

  const keepKeys = buildRenderedVisibleKeySet(renderedMessages)
  if (keepKeys.size === 0) return input

  const bundles = buildPayloadBundles(input)
  const filtered = bundles.filter((bundle) => {
    for (const key of bundle.visibleKeys) {
      if (keepKeys.has(key)) return true
    }
    return false
  })

  return filtered.flatMap((bundle) => bundle.items)
}
