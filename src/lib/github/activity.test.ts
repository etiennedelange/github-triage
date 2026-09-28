import { describe, expect, it } from "vitest";

import { diffSeen, followedAt, toActivity, type Snapshot } from "./activity";
import { describeErrors } from "./http";

const user = (login: string) => ({ login, avatarUrl: `a/${login}`, url: `https://github.com/${login}` });

describe("followers", () => {
  it("reads the follow time out of GitHub's cursor, and gives up on anything else", () => {
    expect(followedAt("Y3Vyc29yOnYyOpK0MjAyNS0wOS0yNVQwMzowMToxNFrODTqGyA==")).toBe("2025-09-25T03:01:14Z");
    expect(followedAt("Y3Vyc29yOnYyOpK0MjAyNi0wOS0yNlQxMToyMDo0M1rOEJU-sg==")).toBe("2026-09-26T11:20:43Z");
    expect(followedAt("Y3Vyc29yOjE=")).toBeNull();
    expect(followedAt("not base64!")).toBeNull();
  });

  it("baselines the first list, then dates newcomers and forgets whoever left", () => {
    const first = diffSeen(undefined, ["ann", "bob"], "t1");
    expect(first).toEqual({ ann: null, bob: null });
    const second = diffSeen(first, ["bob", "cat"], "t2");
    expect(second).toEqual({ bob: null, cat: "t2" });
    expect(diffSeen(second, ["bob", "cat", "ann"], "t3")).toEqual({ bob: null, cat: "t2", ann: "t3" });
  });
});

describe("activity", () => {
  it("merges stars, follows and watches newest first, skipping baseline ones with no known time", () => {
    const snap: Snapshot = {
      followers: [
        { ...user("exact"), followedAt: "2026-03-01T00:00:00Z" },
        { ...user("seen"), followedAt: null },
        { ...user("old"), followedAt: null },
      ],
      followerCount: 3,
      stars: [{ kind: "star", at: "2026-02-01T00:00:00Z", user: user("fan"), repo: "me/app" }],
      starCount: 4,
      watchers: [
        { kind: "watch", user: user("eye"), repo: "me/app" },
        { kind: "watch", user: user("old"), repo: "me/app" },
      ],
      watcherCount: 2,
      complete: { followers: true, watchers: true },
    };
    const seen = {
      followers: { exact: null, seen: "2026-04-01T00:00:00Z", old: null },
      watchers: { "me/app eye": "2026-05-01T00:00:00Z", "me/app old": null },
    };
    const a = toActivity(snap, seen, "now");
    expect(a.events.map((e) => [e.kind, e.user.login, e.kind === "follow" && e.exact])).toEqual([
      ["watch", "eye", false],
      ["follow", "seen", false],
      ["follow", "exact", true],
      ["star", "fan", false],
    ]);
    expect(a).toMatchObject({ followers: 3, stars: 4, watchers: 2 });
  });
});

describe("GraphQL errors", () => {
  it("collapses GitHub's per-node repeats into one line with where they hit", () => {
    const denied = "Resource not accessible by integration";
    const errors = [0, 1, 2, 3].map((i) => ({ message: denied, path: ["viewer", "followers", "edges", i, "node"] }));
    expect(describeErrors([...errors, { message: "Other" }])).toBe(
      `${denied} (4×, at viewer.followers.edges.0.node, viewer.followers.edges.1.node, viewer.followers.edges.2.node, …); Other`,
    );
  });
});
