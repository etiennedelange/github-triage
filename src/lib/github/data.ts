import "server-only";

import { cacheLife, cacheTag } from "next/cache";
import { z } from "zod";

import {
  codeScanningAlert,
  dependabotAlert,
  issueNode,
  pullRequestNode,
  secretScanningAlert,
  type AlertSource,
  type ScannerStatus,
  type SecurityAlert,
} from "@/lib/triage";

import { GitHubError, graphql, mapLimit, MissingTokenError, rest } from "./client";

export const GITHUB_TAG = "github";

/**
 * Cached functions return failures as values: errors thrown across a `use cache`
 * boundary are redacted in production, which would hide "no token" from the UI.
 */
export type Failure = { kind: "no-token" | "github" | "unexpected"; message: string; status?: number };
export type Result<T> = { ok: true; data: T } | { ok: false; error: Failure };

function toFailure(err: unknown): Failure {
  if (err instanceof MissingTokenError) return { kind: "no-token", message: err.message };
  if (err instanceof GitHubError) return { kind: "github", message: err.message, status: err.status };
  if (err instanceof z.ZodError) return { kind: "unexpected", message: `Unexpected GitHub response: ${z.prettifyError(err)}` };
  return { kind: "unexpected", message: err instanceof Error ? err.message : String(err) };
}

/** Extra orgs/users (besides you) whose repos count as "yours" for incoming work and security scans. */
function extraOwners(): string[] {
  return (process.env.TRIAGE_OWNERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const maxRepos = () => Number(process.env.TRIAGE_MAX_REPOS) || 50;

// ---------- Inbox: PRs & issues in a single GraphQL round trip ----------

const ITEM_FIELDS = `
  number title url createdAt updatedAt
  author { login }
  repository { nameWithOwner }
  labels(first: 5) { nodes { name color } }
  comments { totalCount }`;

const INBOX_QUERY = `
query Inbox($review: String!, $mine: String!, $incoming: String!, $assigned: String!, $untriaged: String!) {
  viewer { login avatarUrl }
  review: search(query: $review, type: ISSUE, first: 50) { issueCount nodes { ...PR } }
  mine: search(query: $mine, type: ISSUE, first: 50) { issueCount nodes { ...PR } }
  incoming: search(query: $incoming, type: ISSUE, first: 50) { issueCount nodes { ...PR } }
  assigned: search(query: $assigned, type: ISSUE, first: 50) { issueCount nodes { ...Issue } }
  untriaged: search(query: $untriaged, type: ISSUE, first: 50) { issueCount nodes { ...Issue } }
}
fragment PR on PullRequest {
  __typename ${ITEM_FIELDS}
  isDraft reviewDecision mergeable additions deletions
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}
fragment Issue on Issue {
  __typename ${ITEM_FIELDS}
  assignees(first: 3) { nodes { login } }
}`;

const searchOf = <T extends z.ZodType>(node: T) =>
  z.object({ issueCount: z.number(), nodes: z.array(node) }).transform((s) => ({ total: s.issueCount, items: s.nodes }));

const inboxResponse = z.object({
  viewer: z.object({ login: z.string(), avatarUrl: z.string() }),
  review: searchOf(pullRequestNode),
  mine: searchOf(pullRequestNode),
  incoming: searchOf(pullRequestNode),
  assigned: searchOf(issueNode),
  untriaged: searchOf(issueNode),
});

export type InboxSection = "review" | "mine" | "incoming" | "assigned" | "untriaged";
export type Inbox = z.output<typeof inboxResponse> & { queries: Record<InboxSection, string> };

let loginPromise: Promise<string> | undefined;

/** Memoized for the process: the token's owner doesn't change while it runs. */
function viewerLogin(): Promise<string> {
  loginPromise ??= graphql<{ viewer: { login: string } }>("query { viewer { login } }", {}).then((d) => d.viewer.login);
  loginPromise.catch(() => (loginPromise = undefined));
  return loginPromise;
}

export async function getInbox(): Promise<Result<Inbox>> {
  "use cache";
  cacheTag(GITHUB_TAG);
  try {
    const data = await fetchInbox();
    cacheLife("minutes");
    return { ok: true, data };
  } catch (err) {
    cacheLife("seconds"); // don't pin a failure; the next request retries
    return { ok: false, error: toFailure(err) };
  }
}

async function fetchInbox(): Promise<Inbox> {
  const owners = [await viewerLogin(), ...extraOwners()].map((o) => `user:${o}`).join(" ");
  const open = "is:open archived:false sort:updated-desc";
  const queries = {
    review: `${open} is:pr review-requested:@me`,
    mine: `${open} is:pr author:@me`,
    incoming: `${open} is:pr ${owners} -author:@me`,
    assigned: `${open} is:issue assignee:@me`,
    untriaged: `${open} is:issue no:assignee ${owners}`,
  };
  const data = inboxResponse.parse(await graphql(INBOX_QUERY, queries));

  // A PR where your review is requested belongs in "review", not also in "incoming".
  const reviewUrls = new Set(data.review.items.map((pr) => pr.url));
  const incoming = data.incoming.items.filter((pr) => !reviewUrls.has(pr.url));
  data.incoming = {
    total: data.incoming.total - (data.incoming.items.length - incoming.length),
    items: incoming,
  };
  return { ...data, queries };
}

// ---------- Rate limits ----------

const budget = z.object({ limit: z.number(), remaining: z.number(), reset: z.number() }).transform((b) => ({
  limit: b.limit,
  remaining: b.remaining,
  resetAt: new Date(b.reset * 1000).toISOString(),
}));
const rateLimitResponse = z.object({ resources: z.object({ graphql: budget, core: budget }) });

export type RateLimits = { graphql: z.output<typeof budget>; rest: z.output<typeof budget> };

/** Both API budgets. `/rate_limit` doesn't count against either, so it can stay nearly live. */
export async function getRateLimits(): Promise<Result<RateLimits>> {
  "use cache";
  cacheTag(GITHUB_TAG);
  cacheLife("seconds");
  try {
    const { resources } = rateLimitResponse.parse(await rest("/rate_limit"));
    return { ok: true, data: { graphql: resources.graphql, rest: resources.core } };
  } catch (err) {
    return { ok: false, error: toFailure(err) };
  }
}

// ---------- Security: Dependabot, code scanning & secret scanning per repo ----------

const repoList = z.array(
  z.object({ full_name: z.string(), archived: z.boolean(), fork: z.boolean() }),
);

/** Your repos plus TRIAGE_OWNERS' repos (incl. private org repos), most recently pushed first. */
async function listRepos(): Promise<string[]> {
  const owners = new Set([await viewerLogin(), ...extraOwners()].map((o) => o.toLowerCase()));
  const affiliation = owners.size > 1 ? "owner,organization_member" : "owner";
  const wanted: string[] = [];
  // sort=pushed is global across pages, so we can stop once we have enough.
  for (let page = 1; page <= 10 && wanted.length < maxRepos(); page++) {
    const batch = repoList.parse(
      await rest(`/user/repos?affiliation=${affiliation}&sort=pushed&per_page=100&page=${page}`),
    );
    for (const r of batch) {
      if (!r.archived && !r.fork && owners.has(r.full_name.split("/")[0].toLowerCase())) wanted.push(r.full_name);
    }
    if (batch.length < 100) break;
  }
  return wanted.slice(0, maxRepos());
}

const ALERT_PAGE = 100;

const SCANNERS = {
  dependabot: { path: "dependabot/alerts", schema: dependabotAlert },
  "code-scanning": { path: "code-scanning/alerts", schema: codeScanningAlert },
  "secret-scanning": { path: "secret-scanning/alerts", schema: secretScanningAlert },
} satisfies Record<AlertSource, { path: string; schema: z.ZodType }>;

type ScanResult = { status: ScannerStatus; message?: string; alerts: SecurityAlert[]; truncated: boolean };

async function scan(repo: string, source: AlertSource): Promise<ScanResult> {
  const { path, schema } = SCANNERS[source];
  try {
    const raw = await rest<unknown[]>(`/repos/${repo}/${path}?state=open&per_page=${ALERT_PAGE}`);
    const alerts = z
      .array(schema)
      .parse(raw)
      .map((a) => ({ ...a, repo }) as SecurityAlert);
    return { status: "ok", alerts, truncated: raw.length === ALERT_PAGE };
  } catch (err) {
    if (!(err instanceof GitHubError)) throw err;
    // 404 = feature off / no analysis yet; 403 = feature off, or the token lacks the scope.
    const status: ScannerStatus =
      err.status === 404 || /disabled|not enabled|no analysis/i.test(err.message)
        ? "disabled"
        : err.status === 403
          ? "forbidden"
          : "error";
    return { status, message: err.message, alerts: [], truncated: false };
  }
}

export type SecurityReport = {
  alerts: SecurityAlert[];
  repos: { repo: string; scanners: Record<AlertSource, { status: ScannerStatus; message?: string }> }[];
  truncated: string[];
  scannedAt: string;
};

export async function getSecurity(): Promise<Result<SecurityReport>> {
  "use cache";
  cacheTag(GITHUB_TAG);
  try {
    const data = await fetchSecurity();
    // Fans out to 3 calls per repo, so refresh less eagerly than the inbox.
    cacheLife({ stale: 300, revalidate: 900, expire: 3600 });
    return { ok: true, data };
  } catch (err) {
    cacheLife("seconds");
    return { ok: false, error: toFailure(err) };
  }
}

async function fetchSecurity(): Promise<SecurityReport> {
  const repos = await listRepos();
  const sources = Object.keys(SCANNERS) as AlertSource[];
  const jobs = repos.flatMap((repo) => sources.map((source) => ({ repo, source })));
  const results = await mapLimit(jobs, 6, ({ repo, source }) => scan(repo, source));

  const report: SecurityReport = { alerts: [], repos: [], truncated: [], scannedAt: new Date().toISOString() };
  repos.forEach((repo, r) => {
    const scanners = {} as SecurityReport["repos"][number]["scanners"];
    sources.forEach((source, s) => {
      const res = results[r * sources.length + s];
      scanners[source] = { status: res.status, message: res.message };
      report.alerts.push(...res.alerts);
      if (res.truncated) report.truncated.push(`${repo} (${source})`);
    });
    report.repos.push({ repo, scanners });
  });
  return report;
}
