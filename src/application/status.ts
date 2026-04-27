import type { DcpState } from "../types/state.js"

export type DcpStatusContext = {
  ui: {
    setStatus?(key: string, value: string): void
  }
}

function formatCompactCount(value: number): string {
  const rounded = Math.max(0, Math.round(value))
  if (rounded < 1000) return String(rounded)

  const units = [
    { suffix: "m", value: 1_000_000 },
    { suffix: "k", value: 1_000 },
  ] as const

  for (const unit of units) {
    if (rounded >= unit.value) {
      const scaled = rounded / unit.value
      const formatted = scaled >= 100 ? Math.round(scaled).toString() : scaled.toFixed(1).replace(/\.0$/, "")
      return `${formatted}${unit.suffix}`
    }
  }

  return String(rounded)
}

/** Build the footer status text from one coherent DCP state snapshot. */
export function buildDcpStatusText(state: DcpState): string {
  if (state.manualMode) return "DCP [manual]"

  const activeBlocks = state.compressionBlocks.filter((block) => block.active)
  if (state.tokensSaved <= 0 && state.totalPruneCount <= 0 && activeBlocks.length === 0) {
    return "DCP"
  }

  const parts = ["DCP"]
  if (state.tokensSaved > 0) parts.push(`${formatCompactCount(state.tokensSaved)} saved`)
  if (state.totalPruneCount > 0) parts.push(`${formatCompactCount(state.totalPruneCount)} prunes`)
  if (activeBlocks.length > 0) {
    const latestBlockId = activeBlocks.reduce((max, block) => Math.max(max, block.id), 0)
    parts.push(`b${latestBlockId}`)
  }

  return parts.join(" ")
}

/** Update pi's footer status from the current DCP state. */
export function updateDcpStatus(ctx: DcpStatusContext, state: DcpState): void {
  ctx.ui.setStatus?.("dcp", buildDcpStatusText(state))
}
