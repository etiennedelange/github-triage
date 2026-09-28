// Stale branches on your repos, in one GraphQL round trip: branches left behind after their
// PR merged or closed, and branches nobody has pushed to in STALE_DAYS with no PR at all.
// Branches with an open PR are skipped; the PR panels already show them.

import { z } from "zod";

import { isStale } from "@/lib/triage";

import { graphql, type GitHubAuth } from "./http";

/** Branches read per repo. A repo with more says so in `truncated`. */
const BRANCHES_PER_REPO = 100;

const QUERY = `
query ($repos: Int!, $affiliations: [RepositoryAffiliation], $branches: Int!) {
  viewer {
    repositories(ownerAffiliations: $affiliations, isFork: false, isArchived: false, first: $repos, orderBy: { field: PUSHED_AT, direction: DESC }) {
      nodes {
        nameWithOwner
        url
        defaultBranchRef { name }
        refs(refPrefix: "refs/heads/", first: $branches) {
          totalCount
          nodes {
            name
            target { ... on Commit { committedDate author { name user { login } } } }
            associatedPullRequests(first: 1, orderBy: { field: UPDATED_AT, direction: DESC }) {
              nodes { number url state closedAt }
            }
          }
        }
      }
    }
  }
}`;

const pr = z.object({ number: z.number(), url: z.string(), state: z.enum(["OPEN", "CLOSED", "MERGED"]), closedAt: z.string().nullable() });

const repoNode = z.object({
  nameWithOwner: z.string(),
  url: z.string(),
  defaultBranchRef: z.object({ name: z.string() }).nullable(),
  refs: z
    .object({
      totalCount: z.number(),
      nodes: z.array(
        z.object({
          name: z.string(),
          // A tag-like ref or a tree can sit under refs/heads in odd repos: no commit fields.
          target: z
            .object({
              committedDate: z.string().optional(),
              author: z
                .object({ name: z.string().nullable(), user: z.object({ login: z.string() }).nullable() })
                .nullable()
                .optional(),
            })
            .nullable(),
          associatedPullRequests: z.object({ nodes: z.array(pr.nullable()) }),
        }),
      ),
    })
    .nullable(),
});
export type RepoNode = z.infer<typeof repoNode>;

const response = z.object({ viewer: z.object({ repositories: z.object({ nodes: z.array(repoNode.nullable()) }) }) });

/**
 * Why a branch is listed. `merged`/`closed`: its PR is done and it has had no commits since,
 * so it's safe to delete. `idle`: no PR ever, and nothing pushed in STALE_DAYS.
 */
export type StaleReason = "merged" | "closed" | "idle";

export type StaleBranch = {
  repo: string;
  name: string;
  url: string;
  reason: StaleReason;
  /** The branch's last commit. */
  committedAt: string;
  author: string;
  pr?: { number: number; url: string };
};

export type BranchReport = {
  branches: StaleBranch[];
  /** Repos checked. */
  repos: number;
  /** Repos with more branches than were read. */
  truncated: string[];
  fetchedAt: string;
};

const REASON_RANK: Record<StaleReason, number> = { merged: 0, closed: 1, idle: 2 };

/** Pure: the stale branches in these repos, safest to delete first, then oldest first. */
export function staleBranches(repos: RepoNode[], now = Date.now()): StaleBranch[] {
  const out: StaleBranch[] = [];
  for (const repo of repos) {
    for (const ref of repo.refs?.nodes ?? []) {
      const committedAt = ref.target?.committedDate;
      if (ref.name === repo.defaultBranchRef?.name || !committedAt) continue;
      const last = ref.associatedPullRequests.nodes[0];
      if (last?.state === "OPEN") continue;
      // Pushed to after its PR closed: there's work the PR didn't take, so treat it like no PR.
      const done = last && last.closedAt && committedAt <= last.closedAt;
      const reason: StaleReason | null = done ? (last.state === "MERGED" ? "merged" : "closed") : isStale(committedAt, now) ? "idle" : null;
      if (!reason) continue;
      out.push({
        repo: repo.nameWithOwner,
        name: ref.name,
        url: `${repo.url}/tree/${ref.name.split("/").map(encodeURIComponent).join("/")}`,
        reason,
        committedAt,
        author: ref.target?.author?.user?.login ?? ref.target?.author?.name ?? "unknown",
        pr: done ? { number: last.number, url: last.url } : undefined,
      });
    }
  }
  return out.sort((a, b) => REASON_RANK[a.reason] - REASON_RANK[b.reason] || a.committedAt.localeCompare(b.committedAt));
}

/** `owners`: you plus TRIAGE_OWNERS. Up to `max` repos, most recently pushed first. */
export async function fetchBranches(auth: GitHubAuth, owners: string[], max: number): Promise<BranchReport> {
  const fetchedAt = new Date().toISOString();
  const wanted = new Set(owners.map((o) => o.toLowerCase()));
  const data = response.parse(
    await graphql(auth, QUERY, {
      repos: Math.min(max, 100),
      affiliations: wanted.size > 1 ? ["OWNER", "ORGANIZATION_MEMBER"] : ["OWNER"],
      branches: BRANCHES_PER_REPO,
    }),
  );
  const repos = data.viewer.repositories.nodes.filter(
    (r): r is RepoNode => r !== null && wanted.has(r.nameWithOwner.split("/")[0].toLowerCase()),
  );
  return {
    branches: staleBranches(repos, Date.parse(fetchedAt)),
    repos: repos.length,
    truncated: repos.filter((r) => (r.refs?.totalCount ?? 0) > BRANCHES_PER_REPO).map((r) => r.nameWithOwner),
    fetchedAt,
  };
}
