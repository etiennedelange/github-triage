import { describe, expect, it } from "vite-plus/test";

import { overlayAlerts, overlayItems, type AlertPatch, type ItemPatch } from "./live";
import type { PullRequest, SecurityAlert } from "./triage";

const pr = (n: number, updatedAt: string, title = "t") =>
  ({ kind: "pr", number: n, url: `u/${n}`, updatedAt, title }) as unknown as PullRequest;

describe("overlayItems", () => {
  const server = [pr(2, "2026-09-02"), pr(1, "2026-09-01")];

  it("adds a new item, updates a changed one and flags only those as live", () => {
    const patches = new Map<string, ItemPatch>([
      ["u/3", { at: 20, item: pr(3, "2026-09-03"), sections: ["review"] }],
      ["u/1", { at: 20, item: pr(1, "2026-09-04", "renamed"), sections: ["review"] }],
      ["u/2", { at: 20, item: pr(2, "2026-09-02"), sections: ["review"] }], // unchanged (poll overlap)
    ]);
    const out = overlayItems("review", server, patches, 10);
    expect(out.items.map((i) => i.number)).toEqual([1, 3, 2]);
    expect(out.delta).toBe(1);
    expect([...out.live.keys()].sort()).toEqual(["u/1", "u/3"]);
  });

  it("removes items that left the section or disappeared", () => {
    const patches = new Map<string, ItemPatch>([
      ["u/1", { at: 20, item: pr(1, "2026-09-05"), sections: ["mine"] }],
      ["u/2", { at: 20, item: null, sections: [] }],
    ]);
    const out = overlayItems("review", server, patches, 10);
    expect(out.items).toEqual([]);
    expect(out.delta).toBe(-2);
  });

  it("ignores patches the snapshot already includes", () => {
    const patches = new Map<string, ItemPatch>([["u/2", { at: 5, item: null, sections: [] }]]);
    const out = overlayItems("review", server, patches, 10);
    expect(out.items.map((i) => i.number)).toEqual([2, 1]);
    expect(out.delta).toBe(0);
  });
});

describe("overlayAlerts", () => {
  const alert = (url: string) => ({ url, severity: "high" }) as SecurityAlert;

  it("adds and removes alerts newer than the scan", () => {
    const patches = new Map<string, AlertPatch>([
      ["a", { at: 20, alert: null }],
      ["b", { at: 20, alert: alert("b") }],
      ["c", { at: 5, alert: null }], // older than the scan: ignored
    ]);
    const out = overlayAlerts([alert("a"), alert("c")], patches, 10);
    expect(out.items.map((a) => a.url)).toEqual(["c", "b"]);
    expect(out.delta).toBe(0);
    expect([...out.live.keys()]).toEqual(["b"]);
  });
});
