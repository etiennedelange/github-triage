// "Fix with Claude" on GitHub: is the Action set up in a repo, and post the @claude comment.
// No env reads: the Hub passes the token.

import { z } from "zod";

import { branchForRun, CLAUDE_BOT, usesClaudeAction, type ClaudeRun, type ClaudeSignal } from "@/lib/claude";

import { GitHubError, rest, type GitHubAuth } from "./http";

const dirEntry = z.array(z.object({ name: z.string(), path: z.string(), type: z.string() }));
const fileEntry = z.object({ content: z.string(), encoding: z.string() });

/** Workflows read per check, most likely first: enough for any repo that isn't a workflow zoo. */
const MAX_WORKFLOWS = 20;

/**
 * Whether any workflow in the repo's default branch uses anthropics/claude-code-action.
 * Asked when you open the popover, so it's never stale: a listing plus one read per workflow
 * until one matches, with files named like "claude" read first.
 */
export async function hasClaudeWorkflow(auth: GitHubAuth, repo: string): Promise<boolean> {
  let entries: z.infer<typeof dirEntry>;
  try {
    entries = dirEntry.parse(await rest(auth, `/repos/${repo}/contents/.github/workflows`));
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) return false; // no workflows at all
    throw err;
  }
  const workflows = entries
    .filter((e) => e.type === "file" && /\.ya?ml$/i.test(e.name))
    .toSorted((a, b) => Number(/claude/i.test(b.name)) - Number(/claude/i.test(a.name)))
    .slice(0, MAX_WORKFLOWS);
  for (const w of workflows) {
    const file = fileEntry.parse(await rest(auth, `/repos/${repo}/contents/${w.path.split("/").map(encodeURIComponent).join("/")}`));
    if (file.encoding === "base64" && usesClaudeAction(atob(file.content.replace(/\s/g, "")))) return true;
  }
  return false;
}

const comment = z.object({ html_url: z.string() });

/** Posts on an issue (or PR) conversation; returns the comment's URL. */
export async function postIssueComment(auth: GitHubAuth, repo: string, number: number, body: string): Promise<string> {
  return comment.parse(await rest(auth, `/repos/${repo}/issues/${number}/comments`, { body })).html_url;
}

const commentAuthors = z.array(z.object({ user: z.object({ login: z.string() }).nullable() }));
const refs = z.array(z.object({ ref: z.string() }));
const pulls = z.array(z.object({ html_url: z.string() }));

/**
 * Where a run has got, read from GitHub instead of webhooks: Claude's comment, its branch, a
 * PR from the branch. Only asks about the steps the run hasn't reached (at most three calls).
 */
export async function fetchRunProgress(auth: GitHubAuth, run: ClaudeRun): Promise<ClaudeSignal[]> {
  const { repo, number } = run;
  const signals: ClaudeSignal[] = [];
  if (run.state === "requested") {
    const since = encodeURIComponent(run.requestedAt);
    const comments = commentAuthors.parse(await rest(auth, `/repos/${repo}/issues/${number}/comments?since=${since}&per_page=100`));
    if (comments.some((c) => c.user?.login === CLAUDE_BOT)) signals.push({ kind: "working", repo, number });
  }
  let branch = run.branch;
  if (!branch) {
    const found = refs.parse(await rest(auth, `/repos/${repo}/git/matching-refs/heads/claude/issue-${number}-`));
    branch = branchForRun(run, found.map((r) => r.ref.replace(/^refs\/heads\//, "")));
    if (branch) signals.push({ kind: "branch", repo, number, branch });
  }
  if (branch) {
    const head = encodeURIComponent(`${repo.split("/")[0]}:${branch}`);
    const [pr] = pulls.parse(await rest(auth, `/repos/${repo}/pulls?head=${head}&state=all&per_page=1`));
    if (pr) signals.push({ kind: "pr", repo, number, url: pr.html_url });
  }
  return signals;
}
