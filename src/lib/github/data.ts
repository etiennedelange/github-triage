import "server-only";

import { unstable_cache } from "next/cache";
import { z } from "zod";

import { issueNode, pullRequestNode, type AlertSource, type InboxSection } from "@/lib/triage";

import { GitHubError, graphql, mapLimit, MissingTokenError, oauthEnabled, rest, withToken } from "./client";
import { ITEM_FRAGMENTS } from "./fragments";
import { scanOne, SCANNERS, type SecurityReport } from "./security";

export type { SecurityReport } from "./security";

export type { InboxSection } from "@/lib/triage";

/** Inbox & rate limits: cheap to refetch, so a manual refresh invalidates this. */
export const GITHUB_TAG = "github";
/** Security scan: expensive (fans out per repo), so it revalidates on its own schedule instead of on every manual refresh. */
export const GITHUB_SECURITY_TAG = "github-security";

/**
 * Public getters return failures as values, so the UI can say "no token" or "scanning"
 * instead of hitting an error boundary. The cached parts throw, so failures are never cached.
 *
 * Caching uses `unstable_cache`, not `use cache`: Cache Components (which `use cache` needs)
 * hangs page streaming on production Workers (opennextjs/opennextjs-cloudflare#1225).
 */
export type Failure = { kind: "no-token" | "github" | "unexpected" | "scanning"; message: string; status?: number };
export type Result<T> = { ok: true; data: T } | { ok: false; error: Failure };

/** The Hub hasn't finished its first background scan yet: not an error, just not ready. */
class ScanPendingError extends Error {
  constructor() {
    super("Scanning your repos for security alerts — this can take a minute on first load.");
  }
}

function toFailure(err: unknown): Failure {
  if (err instanceof MissingTokenError) return { kind: "no-token", message: err.message };
  if (err instanceof ScanPendingError) return { kind: "scanning", message: err.message };
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

const INBOX_QUERY = `
query Inbox($review: String!, $mine: String!, $incoming: String!, $assigned: String!, $untriaged: String!) {
  viewer { login avatarUrl }
  review: search(query: $review, type: ISSUE, first: 50) { issueCount nodes { ...PR } }
  mine: search(query: $mine, type: ISSUE, first: 50) { issueCount nodes { ...PR } }
  incoming: search(query: $incoming, type: ISSUE, first: 50) { issueCount nodes { ...PR } }
  assigned: search(query: $assigned, type: ISSUE, first: 50) { issueCount nodes { ...Issue } }
  untriaged: search(query: $untriaged, type: ISSUE, first: 50) { issueCount nodes { ...Issue } }
}
${ITEM_FRAGMENTS}`;

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

export type Inbox = z.output<typeof inboxResponse> & {
  queries: Record<InboxSection, string>;
  /** When GitHub was asked; live updates older than this are already in the snapshot. */
  fetchedAt: string;
};

let login: string | undefined;

/**
 * Memoized for the process: the token's owner doesn't change while it runs. Caches the
 * value, not the promise: on Workers a promise whose fetch belongs to one request never
 * settles for another, so sharing an in-flight promise can hang every later request.
 */
async function viewerLogin(): Promise<string> {
  login ??= (await graphql<{ viewer: { login: string } }>("query { viewer { login } }", {})).viewer.login;
  return login;
}

// Single-user app: the cache is global. A multi-user version must key these by login.
const cachedInbox = unstable_cache(() => fetchInbox(), ["inbox"], { tags: [GITHUB_TAG], revalidate: 60 });

export async function getInbox(): Promise<Result<Inbox>> {
  try {
    return { ok: true, data: await cachedInbox() };
  } catch (err) {
    return { ok: false, error: toFailure(err) };
  }
}

async function fetchInbox(): Promise<Inbox> {
  const fetchedAt = new Date().toISOString();
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
  return { ...data, queries, fetchedAt };
}

// ---------- Rate limits ----------

const budget = z.object({ limit: z.number(), remaining: z.number(), reset: z.number() }).transform((b) => ({
  limit: b.limit,
  remaining: b.remaining,
  resetAt: new Date(b.reset * 1000).toISOString(),
}));
const rateLimitResponse = z.object({ resources: z.object({ graphql: budget, core: budget }) });

export type RateLimits = { graphql: z.output<typeof budget>; rest: z.output<typeof budget> };

/** Both API budgets. `/rate_limit` doesn't count against either, so it's fetched live, uncached. */
export async function getRateLimits(): Promise<Result<RateLimits>> {
  try {
    const { resources } = rateLimitResponse.parse(await rest("/rate_limit"));
    return { ok: true, data: { graphql: resources.graphql, rest: resources.core } };
  } catch (err) {
    return { ok: false, error: toFailure(err) };
  }
}

// ---------- Security: Dependabot, code scanning & secret scanning per repo ----------

const repoList = z.array(
  z.object({ full_name: z.string(), archived: z.boolean(), fork: z.boolean(), pushed_at: z.string().nullish() }),
);

/**
 * Your repos plus TRIAGE_OWNERS' repos (incl. private org repos), most recently pushed first.
 * Local/dev only (no GitHub App token): deployed, the Hub scans installed repos instead.
 */
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

// Local/dev has no Hub, so it fans out live here; cache that for 15 minutes.
const cachedLocalSecurity = unstable_cache(() => fetchSecurity(), ["security"], { tags: [GITHUB_SECURITY_TAG], revalidate: 900 });

export async function getSecurity(): Promise<Result<SecurityReport>> {
  try {
    // Deployed, the Hub Durable Object owns the fan-out (chunked across its own alarm ticks,
    // so one Worker invocation never has to make 3-calls-per-repo all at once) and already
    // stores the finished report, so reading it needs no further cache.
    return { ok: true, data: oauthEnabled() ? await fetchSecurityFromHub() : await cachedLocalSecurity() };
  } catch (err) {
    return { ok: false, error: toFailure(err) };
  }
}

async function fetchSecurityFromHub(): Promise<SecurityReport> {
  const { hub } = await import("@/edge/binding");
  const report = await (await hub()).getSecurityReport();
  if (!report) throw new ScanPendingError();
  return report;
}

async function fetchSecurity(): Promise<SecurityReport> {
  const repos = await listRepos();
  const sources = Object.keys(SCANNERS) as AlertSource[];
  const jobs = repos.flatMap((repo) => sources.map((source) => ({ repo, source })));
  const results = await mapLimit(jobs, 6, ({ repo, source }) => withToken((auth) => scanOne(auth, repo, source)));

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
