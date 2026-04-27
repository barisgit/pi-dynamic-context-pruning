import type { DcpState } from "../types/state.js";

export type DcpStatusContext = {
  ui: {
    setStatus?(key: string, value: string): void;
  };
};

function formatCompactCount(value: number): string {
  const rounded = Math.max(0, Math.round(value));
  if (rounded < 1000) return String(rounded);

  if (rounded >= 1_000_000) {
    return `${(rounded / 1_000_000).toFixed(3).replace(/\.?0+$/, "")}M`;
  }

  const scaledThousands = rounded / 1_000;
  if (scaledThousands >= 999.5) return "1M";

  const formattedThousands =
    scaledThousands >= 100
      ? Math.round(scaledThousands).toString()
      : scaledThousands.toFixed(1).replace(/\.0$/, "");
  return `${formattedThousands}k`;
}

/** Build the footer status text from one coherent DCP state snapshot. */
export function buildDcpStatusText(state: DcpState): string {
  if (state.manualMode) return "DCP [manual]";

  const activeBlocks = state.compressionBlocks.filter((block) => block.active);
  if (state.tokensSaved <= 0 && state.totalPruneCount <= 0 && activeBlocks.length === 0) {
    return "DCP";
  }

  const parts = ["DCP"];
  if (state.tokensSaved > 0) parts.push(`${formatCompactCount(state.tokensSaved)} saved`);
  if (state.totalPruneCount > 0) parts.push(`${formatCompactCount(state.totalPruneCount)} prunes`);
  if (activeBlocks.length > 0) {
    const latestBlockId = activeBlocks.reduce((max, block) => Math.max(max, block.id), 0);
    parts.push(`b${latestBlockId}`);
  }

  return parts.join(" ");
}

/** Update pi's footer status from the current DCP state. */
export function updateDcpStatus(ctx: DcpStatusContext, state: DcpState): void {
  ctx.ui.setStatus?.("dcp", buildDcpStatusText(state));
}
