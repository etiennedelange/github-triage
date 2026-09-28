// Stars on your repos and your followers, in one GraphQL round trip. GitHub documents a
// timestamp for stars but not follows, and sends Apps no follow webhook. Follower cursors
// happen to carry the follow time (`followedAt`); when one doesn't, the time the Hub first
// saw the follower stands in (`diffFollowers`).

import { z } from "zod";

import { graphql, type GitHubAuth } from "./http";

/** Latest stars per repo; older ones rarely matter for "who starred me lately". */
const STARS_PER_REPO = 10;
/** Events kept for the panel, newest first. */
export const ACTIVITY_KEPT = 30;

const user = z.object({ login: z.string(), avatarUrl: z.string(), url: z.string() });
export type ActivityUser = z.infer<typeof user>;

export type ActivityEvent =
  | { kind: "star"; at: string; user: ActivityUser; repo: string }
  /** `exact: false`: `at` is when the Hub first saw the follower, not when they followed. */
  | { kind: "follow"; at: string; user: ActivityUser; exact: boolean };

export type Activity = {
  events: ActivityEvent[];
  followers: number;
  stars: number;
  /** Follows without a known time from before this were there when tracking began: not listed. */
  followersTrackedSince: string;
  fetchedAt: string;
};

const QUERY = `
query ($after: String, $withRepos: Boolean!, $stars: Int!) {
  viewer {
    login
    followers(first: 100, after: $after) { totalCount pageInfo { hasNextPage endCursor } edges { cursor node { login avatarUrl url } } }
    repositories(ownerAffiliations: OWNER, isFork: false, first: 100, orderBy: { field: STARGAZERS, direction: DESC }) @include(if: $withRepos) {
      nodes {
        nameWithOwner
        stargazerCount
        stargazers(first: $stars, orderBy: { field: STARRED_AT, direction: DESC }) { edges { starredAt node { login avatarUrl url } } }
      }
    }
  }
}`;

const response = z.object({
  viewer: z.object({
    login: z.string(),
    followers: z.object({
      totalCount: z.number(),
      pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() }),
      edges: z.array(z.object({ cursor: z.string(), node: user })),
    }),
    repositories: z
      .object({
        nodes: z.array(
          z.object({
            nameWithOwner: z.string(),
            stargazerCount: z.number(),
            stargazers: z.object({ edges: z.array(z.object({ starredAt: z.string(), node: user })) }),
          }),
        ),
      })
      .optional(),
  }),
});

type Follower = ActivityUser & { followedAt: string | null };

export type Snapshot = {
  followers: Follower[];
  followerCount: number;
  stars: Extract<ActivityEvent, { kind: "star" }>[];
  starCount: number;
};

/** Your followers (up to 1,000) and the latest stars on each of your repos (up to 100 repos). */
export async function fetchSnapshot(auth: GitHubAuth): Promise<Snapshot> {
  const first = response.parse(await graphql(auth, QUERY, { after: null, withRepos: true, stars: STARS_PER_REPO }));
  const toFollower = (e: { cursor: string; node: ActivityUser }): Follower => ({ ...e.node, followedAt: followedAt(e.cursor) });
  const followers = first.viewer.followers.edges.map(toFollower);
  let page = first.viewer.followers.pageInfo;
  for (let i = 1; i < 10 && page.hasNextPage; i++) {
    const next = response.parse(await graphql(auth, QUERY, { after: page.endCursor, withRepos: false, stars: 0 }));
    followers.push(...next.viewer.followers.edges.map(toFollower));
    page = next.viewer.followers.pageInfo;
  }
  const repos = first.viewer.repositories?.nodes ?? [];
  return {
    followers,
    followerCount: first.viewer.followers.totalCount,
    // Your own stars aren't news; the total is GitHub's and still counts them.
    stars: repos.flatMap((r) =>
      r.stargazers.edges
        .filter((e) => e.node.login !== first.viewer.login)
        .map((e) => ({ kind: "star", at: e.starredAt, user: e.node, repo: r.nameWithOwner }) as const),
    ),
    starCount: repos.reduce((n, r) => n + r.stargazerCount, 0),
  };
}

/**
 * Undocumented: a follower cursor is URL-safe base64 of "cursor:v2:" plus a packed [followed-at, id].
 * Null if GitHub changes the format.
 */
export function followedAt(cursor: string): string | null {
  try {
    const iso = atob(cursor.replace(/-/g, "+").replace(/_/g, "/")).match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/)?.[0];
    return iso && !Number.isNaN(Date.parse(iso)) ? iso : null;
  } catch {
    return null;
  }
}

/** login → when the Hub first saw them follow you; null for those already following when tracking began. */
export type SeenFollowers = Record<string, string | null>;

/**
 * The follower set now, with first-seen times carried over. With nothing seen before, everyone
 * is the baseline (null): we can't tell when they followed. Unfollowers drop out, so a
 * refollow counts as new.
 */
export function diffFollowers(prev: SeenFollowers | undefined, current: ActivityUser[], now: string): SeenFollowers {
  const next: SeenFollowers = {};
  for (const { login } of current) next[login] = prev ? (login in prev ? prev[login] : now) : null;
  return next;
}

export function toActivity(snap: Snapshot, seen: SeenFollowers, trackedSince: string, fetchedAt: string): Activity {
  const follows = snap.followers.flatMap(({ followedAt, ...user }): ActivityEvent[] => {
    const at = followedAt ?? seen[user.login];
    return at ? [{ kind: "follow", at, user, exact: Boolean(followedAt) }] : [];
  });
  const events = [...snap.stars, ...follows].toSorted((a, b) => b.at.localeCompare(a.at)).slice(0, ACTIVITY_KEPT);
  return { events, followers: snap.followerCount, stars: snap.starCount, followersTrackedSince: trackedSince, fetchedAt };
}
