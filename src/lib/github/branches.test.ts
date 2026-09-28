import { describe, expect, it } from "vite-plus/test";

import { staleBranches, type RepoNode } from "./branches";

const NOW = Date.parse("2026-09-28T12:00:00Z");
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

const ref = (name: string, committedDate: string, pr?: { state: "OPEN" | "CLOSED" | "MERGED"; closedAt: string | null }) => ({
  name,
  target: { committedDate, author: { name: "Me", user: { login: "me" } } },
  associatedPullRequests: {
    nodes: pr ? [{ number: 7, url: "https://github.com/me/app/pull/7", ...pr }] : [],
  },
});

const repo = (refs: ReturnType<typeof ref>[]): RepoNode => ({
  nameWithOwner: "me/app",
  url: "https://github.com/me/app",
  defaultBranchRef: { name: "main" },
  refs: { totalCount: refs.length, nodes: refs },
});

describe("stale branches", () => {
  it("lists branches left after their PR, and old ones that never had a PR, safest first", () => {
    const out = staleBranches(
      [
        repo([
          ref("main", daysAgo(90)),
          ref("feat/open", daysAgo(60), { state: "OPEN", closedAt: null }),
          ref("feat/fresh", daysAgo(2)),
          ref("feat/idle", daysAgo(30)),
          ref("feat/closed", daysAgo(3), { state: "CLOSED", closedAt: daysAgo(1) }),
          ref("fix/merged", daysAgo(1), { state: "MERGED", closedAt: daysAgo(1) }),
        ]),
      ],
      NOW,
    );
    expect(out.map((b) => [b.name, b.reason])).toEqual([
      ["fix/merged", "merged"],
      ["feat/closed", "closed"],
      ["feat/idle", "idle"],
    ]);
    expect(out[0]).toMatchObject({ url: "https://github.com/me/app/tree/fix/merged", author: "me", pr: { number: 7 } });
    expect(out[2].pr).toBeUndefined();
  });

  it("treats a branch pushed to after its PR merged as having unmerged work", () => {
    const merged = { state: "MERGED" as const, closedAt: daysAgo(40) };
    const out = staleBranches([repo([ref("reused", daysAgo(3), merged), ref("reused-old", daysAgo(20), merged)])], NOW);
    expect(out.map((b) => [b.name, b.reason])).toEqual([["reused-old", "idle"]]);
  });
});
