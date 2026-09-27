// Targeted GitHub reads for the Hub: only the items an event touched, batched into one query.

import { z } from "zod";

import { ITEM_FRAGMENTS } from "@/lib/github/fragments";
import { graphql, rest, type GitHubAuth } from "@/lib/github/http";
import {
  codeScanningAlert,
  dependabotAlert,
  issueNode,
  pullRequestNode,
  secretScanningAlert,
  type AlertSource,
  type Issue,
  type PullRequest,
  type SecurityAlert,
} from "@/lib/triage";

import type { SubjectKey } from "./events";

/** GitHub caps query complexity; 50 items per request stays well inside it. */
const BATCH = 50;

const itemNode = z.union([pullRequestNode, issueNode]);

export function parseSubject(key: SubjectKey): { owner: string; name: string; number: number } {
  const [repo, n] = key.split("#");
  const [owner, name] = repo.split("/");
  return { owner, name, number: Number(n) };
}

/** Both URL shapes an item could have been rendered under, for removing it when it's gone. */
export function subjectUrls(key: SubjectKey): string[] {
  const { owner, name, number } = parseSubject(key);
  return [`https://github.com/${owner}/${name}/pull/${number}`, `https://github.com/${owner}/${name}/issues/${number}`];
}

/** Current state of each subject; null when it no longer exists or can't be read. */
export async function fetchSubjects(auth: GitHubAuth, keys: SubjectKey[]): Promise<Map<SubjectKey, PullRequest | Issue | null>> {
  const out = new Map<SubjectKey, PullRequest | Issue | null>();
  for (let i = 0; i < keys.length; i += BATCH) {
    const batch = keys.slice(i, i + BATCH);
    const vars: Record<string, unknown> = {};
    const decls: string[] = [];
    const fields = batch.map((key, j) => {
      const { owner, name, number } = parseSubject(key);
      Object.assign(vars, { [`o${j}`]: owner, [`r${j}`]: name, [`n${j}`]: number });
      decls.push(`$o${j}: String!, $r${j}: String!, $n${j}: Int!`);
      return `s${j}: repository(owner: $o${j}, name: $r${j}) { issueOrPullRequest(number: $n${j}) { ...PR ...Issue } }`;
    });
    const query = `query (${decls.join(", ")}) {\n${fields.join("\n")}\n}\n${ITEM_FRAGMENTS}`;
    const data = await graphql<Record<string, { issueOrPullRequest: unknown } | null>>(auth, query, vars, { partial: true });
    batch.forEach((key, j) => {
      const parsed = itemNode.safeParse(data?.[`s${j}`]?.issueOrPullRequest);
      out.set(key, parsed.success ? parsed.data : null);
    });
  }
  return out;
}

/** Every open PR in a repo, after its default branch moved (mergeability may have flipped). */
export async function fetchOpenPrs(auth: GitHubAuth, repo: string): Promise<PullRequest[]> {
  const [owner, name] = repo.split("/");
  const data = await graphql<{ repository: { pullRequests: { nodes: unknown[] } } | null }>(
    auth,
    `query ($o: String!, $r: String!) {
      repository(owner: $o, name: $r) {
        pullRequests(states: OPEN, first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ...PR } }
      }
    }
    ${ITEM_FRAGMENTS}`,
    { o: owner, r: name },
  );
  return z.array(pullRequestNode).parse(data.repository?.pullRequests.nodes ?? []);
}

/**
 * Catch-up for repos the App isn't installed on (so no webhooks): PRs involving you that
 * changed since `since`. Includes closed ones, so they can be removed.
 */
export async function fetchRecentlyUpdated(auth: GitHubAuth, since: string): Promise<(PullRequest | Issue)[]> {
  const window = `archived:false updated:>=${since}`;
  const data = await graphql<Record<"requested" | "reviewed" | "mine" | "assigned", { nodes: unknown[] }>>(
    auth,
    `query ($requested: String!, $reviewed: String!, $mine: String!, $assigned: String!) {
      requested: search(query: $requested, type: ISSUE, first: 30) { nodes { ...PR } }
      reviewed: search(query: $reviewed, type: ISSUE, first: 30) { nodes { ...PR } }
      mine: search(query: $mine, type: ISSUE, first: 30) { nodes { ...PR } }
      assigned: search(query: $assigned, type: ISSUE, first: 30) { nodes { ...Issue } }
    }
    ${ITEM_FRAGMENTS}`,
    {
      requested: `is:pr review-requested:@me ${window}`,
      // A review request disappears once you review; this catches that exit.
      reviewed: `is:pr reviewed-by:@me ${window}`,
      mine: `is:pr author:@me ${window}`,
      assigned: `is:issue assignee:@me ${window}`,
    },
  );
  const seen = new Set<string>();
  return Object.values(data)
    .flatMap((s) => z.array(itemNode).parse(s.nodes))
    .filter((i) => !seen.has(i.url) && seen.add(i.url));
}

/** Teams you're on, as "org/slug", so team review requests land in "review". Needs Members: read. */
export async function fetchTeams(auth: GitHubAuth, login: string): Promise<string[]> {
  const data = await graphql<{ viewer: { organizations: { nodes: { login: string; teams: { nodes: { slug: string }[] } }[] } } }>(
    auth,
    `query ($login: [String!]) {
      viewer { organizations(first: 50) { nodes { login teams(first: 100, userLogins: $login) { nodes { slug } } } } }
    }`,
    { login: [login] },
    { partial: true },
  );
  return (data?.viewer.organizations.nodes ?? []).flatMap((o) => (o?.teams?.nodes ?? []).map((t) => `${o.login}/${t.slug}`));
}

const ALERT_API = {
  dependabot: { path: "dependabot/alerts", schema: dependabotAlert },
  "code-scanning": { path: "code-scanning/alerts", schema: codeScanningAlert },
  "secret-scanning": { path: "secret-scanning/alerts", schema: secretScanningAlert },
} satisfies Record<AlertSource, { path: string; schema: z.ZodType }>;

/** One alert over REST, for when a webhook payload didn't parse. Null if it's not open. */
export async function fetchAlert(auth: GitHubAuth, repo: string, source: AlertSource, number: number): Promise<SecurityAlert | null> {
  const { path, schema } = ALERT_API[source];
  const raw = await rest<{ state?: string }>(auth, `/repos/${repo}/${path}/${number}`);
  if (raw.state !== "open") return null;
  return { ...schema.parse(raw), repo } as SecurityAlert;
}
