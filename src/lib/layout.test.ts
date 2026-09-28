import { describe, expect, it } from "vitest";

import { balancedSplit, splitCost } from "./layout";

describe("splitCost", () => {
  it("is the taller column, gaps included", () => {
    expect(splitCost([100, 100, 300], 2, 10)).toBe(300);
    expect(splitCost([100, 100, 300], 1, 10)).toBe(410);
  });
});

describe("balancedSplit", () => {
  // Four short "waiting on you" panels, then a long incoming list and three FYI panels.
  const board = [120, 155, 170, 120, 710, 475, 180, 270];

  it("moves panels left when the right column leaves a hole", () => {
    expect(balancedSplit(board, 4, 12)).toBe(5);
  });

  it("keeps the split when the gain is under the slack", () => {
    // Waiting-on-you and FYI columns already about even.
    expect(balancedSplit([300, 300, 300, 300], 2, 12)).toBe(2);
    // One more row on the left isn't enough to move a panel.
    expect(balancedSplit([300, 380, 300, 300], 2, 12)).toBe(2);
  });

  it("clamps a split that no longer fits the panel count", () => {
    expect(balancedSplit([200, 200], 4, 12)).toBe(1);
    expect(balancedSplit([200], 4, 12)).toBe(1);
  });
});
