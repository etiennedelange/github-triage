// The PR & issue inbox (one GraphQL round trip) and API budgets. Runtime-agnostic:
// the Hub Durable Object calls these with the token it holds.

import { z } from "zod";

import { issueNode, pullRequestNode, type InboxSection } from "@/lib/triage";

import { ITEM_FRAGMENTS } from "./fragments";
import { graphql, rest, type GitHubAuth } from "./http";

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

/** `owners`: whose repos count as yours (you plus TRIAGE_OWNERS), for incoming PRs and untriaged issues. */
export async function fetchInbox(auth: GitHubAuth, owners: string[]): Promise<Inbox> {
  const fetchedAt = new Date().toISOString();
  const users = owners.map((o) => `user:${o}`).join(" ");
  const open = "is:open archived:false sort:updated-desc";
  const queries = {
    review: `${open} is:pr review-requested:@me`,
    mine: `${open} is:pr author:@me`,
    incoming: `${open} is:pr ${users} -author:@me`,
    assigned: `${open} is:issue assignee:@me`,
    untriaged: `${open} is:issue no:assignee ${users}`,
  };
  const data = inboxResponse.parse(await graphql(auth, INBOX_QUERY, queries));

  // A PR where your review is requested belongs in "review", not also in "incoming".
  const reviewUrls = new Set(data.review.items.map((pr) => pr.url));
  const incoming = data.incoming.items.filter((pr) => !reviewUrls.has(pr.url));
  data.incoming = {
    total: data.incoming.total - (data.incoming.items.length - incoming.length),
    items: incoming,
  };
  return { ...data, queries, fetchedAt };
}

export async function fetchViewerLogin(auth: GitHubAuth): Promise<string> {
  return (await graphql<{ viewer: { login: string } }>(auth, "query { viewer { login } }", {})).viewer.login;
}

// ---------- Rate limits ----------

const budget = z.object({ limit: z.number(), remaining: z.number(), reset: z.number() }).transform((b) => ({
  limit: b.limit,
  remaining: b.remaining,
  resetAt: new Date(b.reset * 1000).toISOString(),
}));
const rateLimitResponse = z.object({ resources: z.object({ graphql: budget, core: budget }) });

export type RateLimits = { graphql: z.output<typeof budget>; rest: z.output<typeof budget> };

/** Both API budgets. `/rate_limit` doesn't count against either, so it's fetched live. */
export async function fetchRateLimits(auth: GitHubAuth): Promise<RateLimits> {
  const { resources } = rateLimitResponse.parse(await rest(auth, "/rate_limit"));
  return { graphql: resources.graphql, rest: resources.core };
}
