/** Height (px) the taller column must shrink by before panels move: more than a row or two. */
export const REBALANCE_SLACK = 120;

/** Height of the taller column when the first `k` panels go left and the rest right. */
export function splitCost(heights: number[], k: number, gap: number): number {
  const column = (hs: number[]) => (hs.length ? hs.reduce((a, b) => a + b, 0) + gap * (hs.length - 1) : 0);
  return Math.max(column(heights.slice(0, k)), column(heights.slice(k)));
}

/**
 * Where to split panels, kept in reading order, between two columns. Stays at `current` unless
 * another split makes the taller column at least `slack` shorter, so a live update that adds a
 * row doesn't move a panel to the other column.
 */
export function balancedSplit(heights: number[], current: number, gap: number, slack = REBALANCE_SLACK): number {
  const n = heights.length;
  if (n < 2) return n;
  const kept = Math.min(Math.max(current, 1), n - 1);
  const now = splitCost(heights, kept, gap);
  let [best, bestCost] = [kept, now];
  for (let k = 1; k < n; k++) {
    const cost = splitCost(heights, k, gap);
    if (cost < bestCost) [best, bestCost] = [k, cost];
  }
  return now - bestCost >= slack ? best : kept;
}
