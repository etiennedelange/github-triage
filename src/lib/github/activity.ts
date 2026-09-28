// Stars and watchers on your repos and your followers, in one GraphQL round trip. GitHub
// documents a timestamp for stars only, and sends Apps no follow or watch webhook (its
// "watch" event is really a star). Follower cursors happen to carry the follow time
// (`followedAt`); for watchers, and followers whose cursor doesn't, the time the Hub first
// saw them stands in (`diffSeen`).

import { z } from "zod";

import { describeErrors, graphql, type GitHubAuth, type GraphQLErrorEntry } from "./http";

/** Latest stars per repo; older ones rarely matter for "who starred me lately". */
const STARS_PER_REPO = 10;
/** Watchers aren't ordered by time, so read enough to see newcomers on a busy repo. */
const WATCHERS_PER_REPO = 50;
/** Events kept for the panel, newest first. */
export const ACTIVITY_KEPT = 30;

const user = z.object({ login: z.string(), avatarUrl: z.string(), url: z.string() });
export type ActivityUser = z.infer<typeof user>;

export type ActivityEvent =
  | { kind: "star"; at: string; user: ActivityUser; repo: string }
  /** `exact: false`: `at` is when the Hub first saw the follower, not when they followed. */
  | { kind: "follow"; at: string; user: ActivityUser; exact: boolean }
  /** `at` is always when the Hub first saw the watcher: GitHub keeps no time for it. */
  | { kind: "watch"; at: string; user: ActivityUser; repo: string };

export type Activity = {
  events: ActivityEvent[];
  /**
   * Set when GitHub won't list stargazers to this token (the App's user token can't): only
   * stars that arrived by webhook since this time are shown.
   */
  starsSince?: string;
  followers: number;
  stars: number;
  /** Other people watching your repos (GitHub counts you as watching your own). */
  watchers: number;
  /** GitHub refused part of the query (e.g. a permission the App lacks); the rest still shows. */
  warning?: string;
  fetchedAt: string;
};

const QUERY = `
query ($after: String, $withRepos: Boolean!, $stars: Int!, $watchers: Int!) {
  viewer {
    login
    followers(first: 100, after: $after) { totalCount pageInfo { hasNextPage endCursor } edges { cursor node { login avatarUrl url } } }
    repositories(ownerAffiliations: OWNER, isFork: false, first: 100, orderBy: { field: STARGAZERS, direction: DESC }) @include(if: $withRepos) {
      nodes {
        nameWithOwner
        stargazerCount
        stargazers(first: $stars, orderBy: { field: STARRED_AT, direction: DESC }) { edges { starredAt node { login avatarUrl url } } }
        watchers(first: $watchers) { totalCount nodes { login avatarUrl url } }
      }
    }
  }
}`;

// Partial results are fine: anything GitHub refuses comes back null and is skipped.
const response = z.object({
  viewer: z.object({
    login: z.string(),
    followers: z
      .object({
        totalCount: z.number(),
        pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() }),
        edges: z.array(z.object({ cursor: z.string(), node: user.nullable() }).nullable()),
      })
      .nullish(),
    repositories: z
      .object({
        nodes: z.array(
          z
            .object({
              nameWithOwner: z.string(),
              stargazerCount: z.number(),
              stargazers: z.object({ edges: z.array(z.object({ starredAt: z.string(), node: user.nullable() }).nullable()) }).nullish(),
              watchers: z.object({ totalCount: z.number(), nodes: z.array(user.nullable()) }).nullish(),
            })
            .nullable(),
        ),
      })
      .nullish(),
  }),
});

type Follower = ActivityUser & { followedAt: string | null };

export type Snapshot = {
  viewer: string;
  followers: Follower[];
  followerCount: number;
  stars: Extract<ActivityEvent, { kind: "star" }>[];
  starCount: number;
  watchers: Omit<Extract<ActivityEvent, { kind: "watch" }>, "at">[];
  watcherCount: number;
  /** False when GitHub refused that part: an empty list then means "unknown", not "nobody". */
  complete: { followers: boolean; watchers: boolean; stars: boolean };
  warning?: string;
};

/** Your followers (up to 1,000), and the latest stars and some watchers on each of your repos (up to 100 repos). */
export async function fetchSnapshot(auth: GitHubAuth): Promise<Snapshot> {
  const errors: GraphQLErrorEntry[] = [];
  const opts = { partial: true, onErrors: (e: GraphQLErrorEntry[]) => void errors.push(...e) };
  const first = response.parse(
    await graphql(auth, QUERY, { after: null, withRepos: true, stars: STARS_PER_REPO, watchers: WATCHERS_PER_REPO }, opts),
  );
  type Edge = { cursor: string; node: ActivityUser | null } | null;
  let followersComplete = Boolean(first.viewer.followers);
  const toFollowers = (edges: Edge[] = []): Follower[] =>
    edges.flatMap((e) => {
      if (!e?.node) followersComplete = false;
      return e?.node ? [{ ...e.node, followedAt: followedAt(e.cursor) }] : [];
    });
  const followers = toFollowers(first.viewer.followers?.edges);
  let page = first.viewer.followers?.pageInfo;
  for (let i = 1; i < 10 && page?.hasNextPage; i++) {
    const next = response.parse(await graphql(auth, QUERY, { after: page.endCursor, withRepos: false, stars: 0, watchers: 0 }, opts));
    if (!next.viewer.followers) followersComplete = false;
    followers.push(...toFollowers(next.viewer.followers?.edges));
    page = next.viewer.followers?.pageInfo;
  }
  const repos = (first.viewer.repositories?.nodes ?? []).filter((r) => r !== null);
  const me = first.viewer.login;
  const watchers = repos.flatMap((r) =>
    (r.watchers?.nodes ?? []).flatMap((u) => (u && u.login !== me ? [{ kind: "watch", user: u, repo: r.nameWithOwner } as const] : [])),
  );
  return {
    viewer: me,
    followers,
    followerCount: first.viewer.followers?.totalCount ?? followers.length,
    // Stargazers are expected to be refused to the App (the webhook log covers them): not a warning.
    warning: describeErrors(errors.filter((e) => !isStargazerError(e))) || undefined,
    // Your own stars aren't news; the total is GitHub's and still counts them.
    stars: repos.flatMap((r) =>
      (r.stargazers?.edges ?? []).flatMap((e) =>
        e?.node && e.node.login !== me ? [{ kind: "star", at: e.starredAt, user: e.node, repo: r.nameWithOwner } as const] : [],
      ),
    ),
    starCount: repos.reduce((n, r) => n + r.stargazerCount, 0),
    watchers,
    complete: {
      followers: followersComplete,
      watchers: Boolean(first.viewer.repositories) && repos.every((r) => r.watchers && !r.watchers.nodes.includes(null)),
      stars: Boolean(first.viewer.repositories) && !errors.some(isStargazerError),
    },
    // Minus yourself on each repo you watch (you do by default).
    watcherCount: repos.reduce((n, r) => n + (r.watchers?.totalCount ?? 0) - (r.watchers?.nodes.some((u) => u?.login === me) ? 1 : 0), 0),
  };
}

const isStargazerError = (e: GraphQLErrorEntry) => e.path?.includes("stargazers") ?? false;

/** Stars recorded from Star webhooks, newest first: the only source when stargazers can't be listed. */
export type StarLog = { since: string; stars: Extract<ActivityEvent, { kind: "star" }>[] };
const STAR_LOG_KEPT = 100;
const starKey = (s: { repo: string; user: ActivityUser }) => `${s.repo} ${s.user.login}`;

export function logStar(log: StarLog, star: Extract<ActivityEvent, { kind: "star" }>, starred: boolean): StarLog {
  const rest = log.stars.filter((s) => starKey(s) !== starKey(star));
  return { ...log, stars: starred ? [star, ...rest].slice(0, STAR_LOG_KEPT) : rest };
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

/** key → when the Hub first saw it; null for what was already there when tracking began. */
export type Seen = Record<string, string | null>;

/** Followers by login; watchers by "owner/repo login". */
export const watcherKey = (w: { repo: string; user: ActivityUser }) => `${w.repo} ${w.user.login}`;

/**
 * The set now, with first-seen times carried over. With nothing seen before, everything is
 * the baseline (null): we can't tell when it happened. Whatever left drops out, so a
 * refollow or rewatch counts as new.
 */
export function diffSeen(prev: Seen | undefined, current: string[], now: string): Seen {
  const next: Seen = {};
  for (const key of current) next[key] = prev ? (key in prev ? prev[key] : now) : null;
  return next;
}

export function toActivity(snap: Snapshot, seen: { followers: Seen; watchers: Seen }, log: StarLog, fetchedAt: string): Activity {
  const follows = snap.followers.flatMap(({ followedAt, ...user }): ActivityEvent[] => {
    const at = followedAt ?? seen.followers[user.login];
    return at ? [{ kind: "follow", at, user, exact: Boolean(followedAt) }] : [];
  });
  const watches = snap.watchers.flatMap((w): ActivityEvent[] => {
    const at = seen.watchers[watcherKey(w)];
    return at ? [{ ...w, at }] : [];
  });
  const listed = new Set(snap.stars.map(starKey));
  // Your own stars aren't news (the webhook sends them too).
  const stars = [...snap.stars, ...log.stars.filter((s) => !listed.has(starKey(s)) && s.user.login !== snap.viewer)];
  const events = [...stars, ...follows, ...watches].toSorted((a, b) => b.at.localeCompare(a.at)).slice(0, ACTIVITY_KEPT);
  return {
    events,
    starsSince: snap.complete.stars ? undefined : log.since,
    followers: snap.followerCount,
    stars: snap.starCount,
    watchers: snap.watcherCount,
    warning: snap.warning,
    fetchedAt,
  };
}
